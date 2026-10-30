/**
 * Install-record barrel export: path confinement, git root and `info/exclude`,
 * canonical serialization, the record store and service, record selection,
 * tool-to-target mapping, the source trust gate, locally modified files and
 * the writer group for the shared-folder sync.
 * @module records
 */
export * from './confine-path';
export * from './git-root';
export * from './install-record-service';
export * from './map-tool-to-target';
export * from './modified-files';
export * from './record-store';
export * from './resolve-record-source';
export * from './sanitize-source';
export * from './select-record';
export * from './serialize-record';
export * from './writer-group';
