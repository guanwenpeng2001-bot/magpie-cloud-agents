# magpie-cloud-agents

An installable Magpie package containing six cloud-agent provider stubs.

**Scaffold only:** metadata is available, but transports are not implemented. With a synthetic account supplied to the loader, every request returns HTTP 501 with a provider-specific JSON error. No vendor requests, child processes, listeners or tunnels are started. OAuth setup returns an honest failure; it does not claim to have verified a CLI login, app session or Dot handshake. API methods expose Magpie's standard key prompt; do not enter real credentials into this scaffold.

## Install and inspect

```sh
magpie plugin add <absolute-path-to-this-repository>
magpie plugin --json
```

| Provider | Display name | Static models | Planned auth shape |
|---|---|---|---|
| `codex-cloud` | Codex Cloud (codex CLI) | `cloud-task` | OAuth auto flow with environment-id prompt |
| `codex-agents` | Codex Agents API | `gpt-6-astra` | OpenAI API key |
| `cursor-cloud` | Cursor Cloud Agents | `composer-2`, `claude-sonnet-4-5` | Cursor user API key |
| `devin-cloud` | Devin Cloud | `devin-session` | Devin API key |
| `dots` | ChatGPT Dot | `dot` | OAuth auto flow for MCP and bundled tunnel |
| `grok-bot` | Grok Bot (xAI desktop) | `app-bot` | OAuth auto flows: app drive first, direct Connect second |

Models declare `tool_call: false`: future cloud agents run tools remotely and return prose. No context limit is invented. Provider and model configuration overrides are preserved. The package exports exactly six plugin functions and a non-function `_internal` object.

## Verify without credentials

```sh
bun scripts/check.mjs
bun scripts/check.mjs --stubs
```

The first command validates exports, hooks, provider names and model floors. `--stubs` additionally checks OAuth failure behavior and every provider's 501 response for stream and non-stream requests. No shared runtime tests are included at this stage; `bun test` reports no test files.

Windows (PowerShell 7):

```powershell
./scripts/try.ps1 -Magpie 'C:\path\to\magpie.exe' -MetadataOnly
```

POSIX:

```sh
MAGPIE=/path/to/magpie sh scripts/try.sh --metadata-only
```

Each recipe creates a fresh `.sandbox/` directory and redirects HOME, USERPROFILE, XDG_CONFIG_HOME, XDG_CACHE_HOME, CODEX_HOME, APPDATA and LOCALAPPDATA. The PowerShell recipe restores the caller's environment. The sandbox is retained for inspection. Extra arguments are full Magpie CLI arguments, for example `plugin list`. POSIX execution is unverified on this Windows host.

## Future options

Entry functions pass the package's options through to each provider factory. The scaffold ignores these reserved options: `progress` (default true), `maxRunMinutes` (30), `maxPromptBytes` (262144), `apiBase` (provider-id map), `codexCloud` (`env`, `attempts`), `cursorCloud.repos`, `devinCloud.maxAcuLimit`, and `codexAgents.environment`. They enable no transport behavior in this release.

## 中文说明

当前版本只验证安装与插件接口，六个 provider 均未实现传输。静态模型与认证方式已列出；OAuth 设置明确失败，不假装已验证真实登录。传入合成账号后，loader 请求均返回带 provider 名称的 501 JSON 错误，不连接厂商、不启动进程或隧道。请勿输入真实凭据。可运行上面的形状检查和隔离沙箱安装命令验证。

## License

MIT; see [LICENSE](LICENSE).
