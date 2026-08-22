import {
  ElasticSearchTransport as CoreElasticSearchTransport,
  ElasticSearchTransportOptions as CoreElasticSearchTransportOptions,
  nodeCACertificateReader,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  ElasticSearchConfig,
} from '../types/hub';
import {
  TelemetryDocument,
  TelemetryTransport,
} from '../types/telemetry';
import {
  Logger,
} from '../utils/logger';
import {
  HubManager,
} from './hub-manager';

/**
 * Manages the Elastic Search transport layer for telemetry.
 *
 * Thin wrapper around `@ai-primitives-hub/infra`'s `ElasticSearchTransport`,
 * which owns the ES client lifecycle
 * (connect/disconnect per hub), event queuing during startup, batched bulk
 * indexing every 10s, monthly index rotation, and corporate-proxy CA-cert
 * trust merging. This class keeps only the VS Code-specific hub-event
 * subscription wiring (`subscribeToHubEvents`) — left extension-side
 * deliberately, per the same "VS Code-event-driven glue with a single
 * consumer, no CLI need yet" precedent as `HubSyncScheduler` (confirmed
 * with the user rather than assumed) — plus routing the ported class's
 * log callback to this extension's `Logger` and optional debug channel.
 *
 * Authentication is handled by the es-telemetry-proxy — this client sends
 * unauthenticated requests to the proxy URL.
 */
export class ElasticSearchTransport implements TelemetryTransport {
  private readonly transport: CoreElasticSearchTransport;
  private readonly logger = Logger.getInstance();
  private debugChannel: vscode.OutputChannel | undefined;
  private disposables: vscode.Disposable[] = [];

  /**
   * Construct the transport, wiring the underlying `infra` transport's
   * log sink and (real, unless overridden) CA-certificate reader.
   * @param options - Overrides for the underlying `infra` transport's ES
   * client builder / CA-certificate reader (test-only; production code
   * should call this with no arguments).
   */
  constructor(options?: Pick<CoreElasticSearchTransportOptions, 'createClient' | 'getCACertificates'>) {
    // `options` is only ever supplied by tests, to inject a stub ES client
    // (and optionally a stub CA-certificate reader). When omitted entirely
    // (production), the real reader is auto-detected; when supplied without
    // a `getCACertificates` key, it stays `undefined` (CA-merging disabled)
    // rather than falling back to the real reader — tests need to be able to
    // force that "unavailable" case regardless of the host's Node version.
    this.transport = new CoreElasticSearchTransport({
      onLog: (level, message) => this.log(level, message),
      getCACertificates: options ? options.getCACertificates : nodeCACertificateReader(),
      createClient: options?.createClient
    });
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    // Route every level through the main logger (which gates by LOG_LEVEL) so the
    // connection lifecycle is observable in the "AI Primitives Hub" output channel,
    // not just on warn/error. The dedicated debug channel (only present with the
    // ES_LOCAL_URL dev override) mirrors everything when enabled.
    this.logger[level](`[ES Transport] ${message}`);
    if (this.debugChannel) {
      const timestamp = new Date().toISOString();
      this.debugChannel.appendLine(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
    }
  }

  /**
   * Buffer a document for the next batched flush (every 10s).
   * If no client is active, documents are queued until one registers.
   * @param doc - the telemetry document to send
   */
  public send(doc: TelemetryDocument): void {
    this.transport.send(doc);
  }

  /**
   * Connect to a hub's Elastic Search proxy.
   * Closes any previously active client, flushes queued events, and starts
   * the periodic flush timer.
   * @param hubId - the hub identifier
   * @param config - Elastic Search connection configuration (proxy URL)
   */
  public async registerHub(hubId: string, config: ElasticSearchConfig): Promise<void> {
    await this.transport.registerHub(hubId, config);
  }

  /**
   * Disconnect the Elastic Search client if it belongs to the given hub.
   * @param hubId - the hub identifier to unregister
   */
  public unregisterHub(hubId: string): void {
    this.transport.unregisterHub(hubId);
  }

  /**
   * Subscribe to hub lifecycle events so the ES client is automatically
   * registered/unregistered as the active hub changes.
   * @param hubManager - the hub manager to subscribe to
   */
  public subscribeToHubEvents(hubManager: HubManager): void {
    const esLocalUrl = process.env.ES_LOCAL_URL;
    if (esLocalUrl) {
      this.debugChannel = vscode.window.createOutputChannel('AI Primitives Hub - Elastic Search');
      this.log('info', `Dev override: using ES_LOCAL_URL=${esLocalUrl}`);
      void this.registerHub('dev-local', { node: esLocalUrl });
      return;
    }

    const registerHubEs = async (hubId: string): Promise<void> => {
      try {
        const hubData = await hubManager.loadHub(hubId);
        const esConfig = hubData.config.telemetry?.elasticSearch;
        if (esConfig) {
          await this.registerHub(hubId, esConfig);
        }
      } catch (error) {
        this.log('warn', `Failed to register telemetry for hub "${hubId}" (non-fatal): ${error}`);
      }
    };

    const registerIfActive = async (hubId: string): Promise<void> => {
      const activeId = await hubManager.getActiveHubId();
      if (hubId === activeId) {
        void registerHubEs(hubId);
      }
    };

    this.disposables.push(
      hubManager.onHubImported((hubId) => {
        void registerIfActive(hubId);
      }),
      hubManager.onHubSynced((hubId) => {
        void registerIfActive(hubId);
      }),
      hubManager.onHubDeleted((hubId) => {
        this.unregisterHub(hubId);
      }),
      hubManager.onActiveHubChanged(({ oldHubId, newHubId }) => {
        if (oldHubId) {
          this.unregisterHub(oldHubId);
        }
        if (newHubId) {
          void registerHubEs(newHubId);
        }
      })
    );

    // Register the current active hub at startup
    void hubManager.getActiveHubId().then((activeHubId) => {
      if (activeHubId) {
        void registerHubEs(activeHubId);
      }
    });
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.transport.dispose();
    this.debugChannel?.dispose();
  }
}
