# 学生侧部署指南

本文面向学生：下载 `aimdware-router`，配置 Tbox/交大云盘，为不同作业准备配置文件，启动路由器，并在交大云盘里确认记录已经上传。

## 0. 需要提前拿到的信息

需要的项目地址

1. [TboxWebdav](https://github.com/1357310795/TboxWebdav)
2. [aimdware github release](https://github.com/zzjc1234/aimdware/releases/tag/v0.1.0)

助教会给你这些值：

| 名称       | 示例                           | 用途                             |
| ---------- | ------------------------------ | -------------------------------- |
| 学生 token | `st_...`                       | 写入 `student_token`，当密码保管 |
| 后端地址   | `https://aimdware.example.edu` | 写入 `backend_url`               |
| 课程代码   | `ECE4721J`                     | 写入 `course`                    |
| 作业标识   | `hw1`、`lab2`、`project`       | 写入 `assignment`                |

`course` 和 `assignment` 只能使用英文字母、数字、下划线、点和短横线。不要写中文、空格或斜杠。

## 1. 下载 router

正式发版后，打开 GitHub release 页面下载最新版本：

```text
https://github.com/zzjc1234/aimdware/releases
```

把下载的文件放到一个固定目录，例如：

```bash
mkdir -p ~/aimdware

# 如果下载的是 Release 里的二进制：
mv ~/Downloads/aimdware-router-macos-arm64 ~/aimdware/aimdware-router

cd ~/aimdware
chmod +x ./aimdware-router
./aimdware-router --help
```

macOS 如果提示文件来自互联网、无法打开，执行：

```bash
xattr -d com.apple.quarantine ./aimdware-router
```

## 2. 配置 Tbox 和交大云盘

router 不保存你的对话正文。它会把捕获到的 JSON 文件通过 Tbox 上传到你自己的交大云盘。

1. 打开交大云盘：`https://jbox.sjtu.edu.cn`
2. 下载并安装 Tbox 桌面客户端。
3. 用 jAccount 登录 Tbox。
4. 在 Tbox 设置里找到 WebDAV/本地服务相关配置。
5. 记下三项信息：

| Tbox 信息        | 写入配置项  | 示例                      |
| ---------------- | ----------- | ------------------------- |
| 本地 WebDAV 地址 | `tbox_url`  | `http://127.0.0.1:50471`  |
| WebDAV 用户名    | `tbox_user` | `admin`                   |
| 用户 token       | `tbox_pass` | Tbox 配置里的 `UserToken` |

端口号以你自己的 Tbox 显示为准，不要照抄示例。

可以用demo.sh来检测tbox

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${TBOX_URL:-http://127.0.0.1:50471}"
USER="${TBOX_USER:-admin}"
TOKEN="${TBOX_USER_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  printf "Tbox UserToken: " >&2
  stty -echo
  read -r TOKEN
  stty echo
  printf "\n" >&2
fi

DIR="aimdware-test-$(date +%s)"
FILE="$(mktemp)"
trap 'rm -f "$FILE"' EXIT

printf ok > "$FILE"

echo "1. Check WebDAV root"
curl -fsS -u "$USER:$TOKEN" -H "Depth: 0" -X PROPFIND "$BASE/" >/dev/null

echo "2. Create test directory: $DIR"
curl -fsS -u "$USER:$TOKEN" -X MKCOL "$BASE/$DIR" >/dev/null

echo "3. Upload probe.txt"
curl -fsS -u "$USER:$TOKEN" -T "$FILE" "$BASE/$DIR/probe.txt" >/dev/null

echo "4. Read probe.txt"
curl -fsS -u "$USER:$TOKEN" "$BASE/$DIR/probe.txt"
printf "\n"

echo "5. Delete probe.txt"
curl -fsS -u "$USER:$TOKEN" -X DELETE "$BASE/$DIR/probe.txt" >/dev/null

echo "6. Delete test directory"
curl -fsS -u "$USER:$TOKEN" -X DELETE "$BASE/$DIR" >/dev/null

echo "Tbox WebDAV check passed"

```

用 `TBOX_USER_TOKEN=<Your-TBOX_USER_TOKEN> bash demo.sh`来检测

把 `Your-TBOX_USER_TOKEN` 换成 Tbox 配置里的顶层 `UserToken`。能看到 `207 Multi-Status` 就可以。`connection refused` 通常表示 Tbox 没开或端口写错。

## 3. 准备一个配置文件

在 `~/aimdware` 目录创建 `aimdware.hw1.yaml`：

```yaml
student_token: st_REPLACE_ME
course: ECE4721J
assignment: hw1
backend_url: http://111.186.57.145:4312

tbox_url: http://127.0.0.1:50471
tbox_user: admin
tbox_pass: TBOX_USER_TOKEN

upstream:
  plugin: openai
  base_url: https://models.sjtu.edu.cn/api/v1
  api_key: sk_REPLACE_ME

# 可选，默认就是 12345
# port: 12345

# 可选，默认会上传到 aimdware/<course>/<assignment>
# 不建议手写 jbox_remote_path，写错会启动失败
```

配置文件里有 token 和密码，保存后限制权限：

```bash
chmod 600 aimdware.hw1.yaml
```

### HTTP/HTTPS 怎么填

按这个规则填，不要混：

| 配置项              | 一般写法                      | 说明                                                     |
| ------------------- | ----------------------------- | -------------------------------------------------------- |
| `backend_url`       | `https://...` 或 `http://...` | 按助教给的填；正式部署一般用 HTTPS，测试/内网可能是 HTTP |
| `tbox_url`          | `http://127.0.0.1:<端口>`     | Tbox 在你电脑本机开的 WebDAV 服务，通常是 HTTP           |
| `upstream.base_url` | `https://...`                 | SJTU/OpenAI/DeepSeek 等线上模型网关通常是 HTTPS          |
| `OPENAI_BASE_URL`   | `http://127.0.0.1:12345/v1`   | AI 工具连本机 router，用 HTTP                            |

如果你的上游模型是本机服务，例如 Ollama/OpenAI-compatible 本地网关，可以写 HTTP：

```yaml
upstream:
  plugin: openai
  base_url: http://127.0.0.1:11434/v1
  api_key: dummy
```

如果需要代理访问 HTTPS 上游或 Codex 登录，只设置 `HTTPS_PROXY`：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
./aimdware-router --config ./aimdware.hw1.yaml
```

通常不要设置 `HTTP_PROXY`。本机 router 和 Tbox 都是 `http://127.0.0.1`，保持直连最省事。

如果你用的是 ChatGPT/Codex 订阅而不是 API key，把 `upstream` 改成：

```yaml
upstream:
  plugin: codex
```

然后登录一次：

```bash
./aimdware-router --config ./aimdware.hw1.yaml auth login codex
./aimdware-router --config ./aimdware.hw1.yaml auth status
```

## 4. 为多个作业准备配置

每个作业一个配置文件，主要只改 `assignment`。

```bash
cp aimdware.hw1.yaml aimdware.hw2.yaml
```

把 `aimdware.hw2.yaml` 里的：

```yaml
assignment: hw1
```

改成：

```yaml
assignment: hw2
```

推荐命名：

```text
aimdware.hw1.yaml
aimdware.hw2.yaml
aimdware.lab1.yaml
aimdware.project.yaml
```

启动哪个作业，就用哪个配置文件。不要在做 `hw2` 时继续用 `hw1` 的配置，否则上传目录会错。

## 5. 启动向导式检查

每次开始作业前按这个顺序检查：

1. Tbox 已登录，WebDAV 本地服务已开启。
2. 当前作业配置里的 `assignment` 是本次作业。
3. 启动 router：

```bash
cd ~/aimdware
./aimdware-router --config ./aimdware.hw1.yaml
```

看到类似输出即可：

```text
aimdware-router listening on http://127.0.0.1:12345
  course:      ECE4721J
  backend:     https://aimdware.example.edu
  tbox:        http://127.0.0.1:50471
```

另开一个终端检查健康状态：

```bash
curl -s http://127.0.0.1:12345/healthz
```

返回 `ok` 或正常响应就说明 router 已启动。

## 6. 让 AI 工具走 router

把你的 AI 工具的 OpenAI base URL 指到本机 router：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:12345/v1
export OPENAI_API_KEY=dummy
```

`OPENAI_API_KEY` 可以随便填一个非空值。真正调用上游模型用的是配置文件里的 `upstream.api_key`，或你登录过的 Codex token。

如果你使用 `plugin: codex`，工具需要调用 Responses API，也就是：

```text
http://127.0.0.1:12345/v1/responses
```

## 7. 确认上传成功

做一次真实模型调用后，router 终端会出现类似日志：

```text
captured record=... session=... turn=1 hash=... size=... -> queued
```

稍等几秒后，打开交大云盘或 Tbox，查看目录：

```text
aimdware/<课程代码>/<作业标识>/
```

例如：

```text
aimdware/ECE4721J/hw1/
```

里面会有类似文件：

```text
<session_id>.json
```

多轮对话通常还是同一个 session 文件，后续轮次会覆盖成最新完整状态。这是正常的。
