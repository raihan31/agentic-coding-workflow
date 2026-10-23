export interface DesktopFile {
  path: string;
  name: string;
  size: number;
  data?: string;
}

export interface DesktopAPI {
  isDesktop: boolean;
  platform: string;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectFile(filters?: { name: string; extensions: string[] }[]): Promise<DesktopFile | null>;
  openInEditor(filePath: string, line?: number, editor?: 'vscode' | 'cursor'): Promise<boolean>;
  sendNotification(title: string, body: string): void;
  openPath(filePath: string): Promise<boolean>;
  isGitRepo(dirPath: string): Promise<boolean>;
  initGitRepo(dirPath: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
  }
}
