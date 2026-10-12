import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';

// Spotify serves cover art from these CDNs.
const SPOTIFY_IMAGE_SOURCES = 'https://i.scdn.co https://*.scdn.co https://*.spotifycdn.com';

export interface WebviewPageOptions {
  webview: vscode.Webview;
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
  title: string;
  /** Also allow images bundled with the extension, not only Spotify's CDN. */
  allowLocalImages: boolean;
}

/** The HTML shell shared by every webview: one nonce-locked script, one stylesheet, a strict CSP. */
export function renderWebviewHtml(options: WebviewPageOptions): string {
  const { webview } = options;
  const nonce = randomBytes(16).toString('base64');
  const imageSources = options.allowLocalImages ? `${SPOTIFY_IMAGE_SOURCES} ${webview.cspSource}` : SPOTIFY_IMAGE_SOURCES;
  const csp = [
    "default-src 'none'",
    `img-src ${imageSources}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${webview.asWebviewUri(options.styleUri)}">
  <title>${options.title}</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${webview.asWebviewUri(options.scriptUri)}"></script>
</body>
</html>`;
}
