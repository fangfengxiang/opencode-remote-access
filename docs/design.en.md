# Design

[简体中文](design.md) · **English**

## Native GUI and IPC

The window uses native OpenCode settings components and error toasts. Errors can be dismissed and also expire automatically. Translation catalogs live in `src/i18n/` and are passed to the host through `Plugin.define({ i18n })` and `ctx.t()`. OpenCode v2.3.0 uses the plugin locale keys `en`, `zh`, `zht`, and `ru`.

The Electron main process owns file access, listening, login logs, and browser actions. The window queries state and requests changes over IPC. Changes to the method table or response shapes use a new IPC version ID so a hot reload receives a fresh client.

## Listener, authentication, and pairing

The gateway discovers the local service address and authentication headers from Desktop. The remote listener binds to the user's address and port and supports HTTP or TLS. Upstream requests go to the local OpenCode service. It loads custom PEM files from user-configured paths or uses system OpenSSL to generate a self-signed certificate. Generated files are cached by access host under the per-user plugin data directory. Private keys are read in the main process.

The gateway applies source allowlist rules to the socket address before authentication or pairing. It tracks HTTPS devices after the TLS handshake and returns HTTP 403 for disallowed requests. Authenticated requests reach the upstream using the local credentials supplied by Desktop.

The local OpenCode service generates a one-time code registered with the active gateway. A browser redeems it for a session cookie and the OpenCode App redeems it for a gateway session. HTTPS uses Secure cookies and HTTPS pairing URLs. **Open in browser** opens a one-time link. Remote usernames and passwords are handled by the authentication flow.

## Configuration and apply behavior

Listener settings are serialized to `~/.opencode/remote.json` and replaced atomically. **Save** stages the settings. **Save and restart** switches the remote listener. The HTTPS switch and certificate settings apply only the TLS configuration and preserve staged address and credential changes.

Certificate format, validity, host coverage, and key matching are checked before applying. On a switch failure, the gateway attempts to restore the previous listener with the certificate material it already had in memory.

## Devices and logs

Browsers get a signed site-specific device cookie. Clients without the cookie can be grouped by a paired session or an identifier derived with a server-side key. Device models depend on the client hints available in the request. Aliases and the device key live in the Desktop plugin's local storage.

The default log path is stored as the relative filename `login.jsonl` and resolved against the per-user plugin data directory. Custom log paths can be absolute. The JSON Lines log keeps the newest 500 entries. Turning recording off preserves existing entries, and clearing applies to the configured file.

## Platforms and build

Desktop functionality uses cross-platform OpenCode GUI, Electron, and Node.js APIs. The optional macOS and Linux shortcuts use a Unix socket. Windows uses Desktop IPC directly and skips the Unix socket server.

`node scripts/build.cjs` bundles the CommonJS source from `src/` into `gui-experimental.cjs`. GitHub installs load the checked-in bundle. Run `node scripts/build.cjs --check` to verify it matches the source.
