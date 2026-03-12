/** Server connection info returned on startup */
export interface VisualServerInfo {
  port: number;
  host: string;
  url: string;
  screenDir: string;
}

/** A user interaction event captured from the browser */
export interface VisualEvent {
  type: string;
  choice?: string;
  text?: string;
  id?: string | null;
  timestamp: number;
}
