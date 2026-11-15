# Features

[简体中文](features.md) · **English**

| Feature | How to use it |
| --- | --- |
| Native settings | Open **Settings → Remote Access**. The page follows the Desktop language and supports Simplified Chinese, Traditional Chinese, English, and Russian. |
| Remote listener | Choose a local IPv4 address and a port distinct from the local OpenCode service. HTTPS can generate a self-signed certificate or load your PEM certificate and key. |
| Remote sign-in | Set a remote username and password. The password starts masked and can be revealed with the eye button. |
| Apply settings | **Save** applies the values on the next start. **Save and restart** applies them now and attempts to restore the previous listener if it fails. |
| Automatic browser sign-in | **Open in browser** generates a temporary pairing link. The browser signs in when it redeems that link. |
| One-time pairing | Choose a browser URL QR code, an OpenCode App QR code, or the pairing link. The QR code is covered and the link crossed out after five minutes. |
| Source restrictions | Accept individual IPs and CIDR ranges. The listener checks the socket source and records blocked attempts in the sign-in log. |
| Current connections | See source IPs, available device information, and TCP connection counts. Manage device aliases. |
| Sign-in log | Keep the most recent 500 records. View them, change the file path, open the file, turn off recording, or clear the log. View, open, and clear are disabled when the log is empty. |
| Terminal controls | Use `oc-listen` and `oc-qr` on macOS and Linux to control the same listener. |

Switching the listener disconnects its current remote connections. Previously paired devices need to sign in or pair again. An empty allowlist allows all sources. Local browser connections follow the configured allowlist.

## Platforms

- Verified with OpenCode Desktop v2.3.0 on macOS.
- The TLS, pairing, WebSocket, allowlist, logging, and main-process tests passed in an Ubuntu 24.04.5 LTS container, with Node.js 18.19.1 and OpenSSL 3.0.13. The Ubuntu Desktop GUI has yet to be tested.
- Windows has an official OpenCode Desktop build. The plugin uses cross-platform Electron and Node.js APIs, and native Windows Desktop testing is pending.
- Optional terminal shortcuts use a Unix socket. On Windows, use Desktop settings to control the listener and pairing.
- Certificate generation requires OpenSSL on PATH. Node.js loads user-supplied PEM files directly.

[Official OpenCode Desktop downloads](https://opencode.ai/docs#desktop)
