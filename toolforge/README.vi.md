# ToolForge

Cho thuê máy tính của bạn làm máy chạy build, và dựng tool trên cả một dàn máy
như vậy — một trình điều phối, nhiều app, mỗi app chia thành các team và các
task siêu nhỏ.

*[English →](README.md)*

```
   laptop của bạn ─┐
      máy bạn bè ─┼─▶  hub  ─▶  tool ─▶ team ─▶ task nhỏ ─▶ chuyển sang máy rảnh bất kỳ
     máy văn phòng ┘        (xếp lịch, giữ lease, tự chuyển máy, tính tiền)
```

Ba thành phần, không phụ thuộc thư viện ngoài, chạy thẳng bằng Node.js:

| Thành phần | Là gì |
| --- | --- |
| **hub** | Bộ điều phối và API. Giữ danh sách máy, danh sách tool và hàng đợi task. |
| **agent** | Cài trên máy được cho thuê. Hỏi hub lấy việc, chạy, và đẩy log về. |
| **cli** | `toolforge` — thêm máy, nạp spec của tool, theo dõi tiến độ. |

## Cài đặt

```bash
git clone https://github.com/Vincentvn28/Vincentvn28.git
cd Vincentvn28/toolforge
node bin/toolforge.js --version      # không cần npm install; yêu cầu Node >= 20.11
npm link                             # tuỳ chọn: để gọi thẳng lệnh `toolforge`
```

## Bắt đầu nhanh

**1. Chạy hub** (trên máy đóng vai trò điều phối):

```bash
toolforge hub start
# dashboard   http://127.0.0.1:7373
# admin token tfk_…                  ← CLI trên máy này tự lưu lại
```

**2. Thêm máy vào dàn.** Tạo mã tham gia rồi gửi cho người khác:

```bash
toolforge invite create --label "nhóm mình" --price 0.02
# code  join_7a5547a9f976
```

Trên mỗi máy muốn cho thuê:

```bash
toolforge agent join --hub http://hub-host:7373 --code join_7a5547a9f976 \
  --name may-lab --slots 3
# tự nhận diện CPU, RAM, các toolchain đã cài, rồi bắt đầu nhận việc
```

Nhấn Ctrl+C để rút máy êm: máy chạy nốt việc đang làm rồi ngừng nhận việc mới.

Nếu muốn tự cấp token, dùng `toolforge machine add --name may-lab` để lấy token,
rồi trên máy đó chạy `toolforge agent start --hub … --token …`.

**3. Mô tả tool** — gồm các team, và các task nhỏ của từng team:

```jsonc
{
  "key": "invoice-app",
  "dispatch": { "mode": "hybrid" },
  "teams": [
    { "key": "backend", "concurrency": 4, "tasks": [
        { "key": "model",  "run": "echo model > src/model.js" },
        { "key": "create", "run": "echo create > src/create.js", "dependsOn": ["model"] },
        { "key": "list",   "run": "echo list > src/list.js",     "dependsOn": ["model"] }
    ]},
    { "key": "qa", "tasks": [
        { "key": "lint", "run": "node --check src/model.js", "dependsOn": ["backend:create", "backend:list"] }
    ]}
  ]
}
```

**4. Chạy:**

```bash
toolforge tool lint  -f spec.json       # kiểm tra offline: phụ thuộc, vòng lặp, lệnh
toolforge tool apply -f spec.json --start
toolforge watch                         # xem sự kiện trực tiếp
toolforge tool show invoice-app         # tiến độ từng team
```

`backend:create` và `backend:list` chạy song song trên hai máy khác nhau ngay khi
`backend:model` xong. `qa:lint` đợi cả hai.

## Chọn nơi chạy việc

Mỗi tool — và mỗi team, mỗi task — chọn một trong ba chế độ:

| Chế độ | Cách hoạt động |
| --- | --- |
| `pinned` | **Chỉ** chạy trên các máy bạn gắn cố định. Nếu các máy đó offline hết, task nằm chờ. |
| `auto` | Chạy trên bất kỳ máy nào trong dàn. **Một máy out ra thì máy khác tự nhận task đó.** |
| `hybrid` | Ưu tiên máy cố định; khi máy đó bận hoặc offline thì tự chuyển sang dàn chung. |

```bash
toolforge tool set invoice-app --mode pinned --machines mch_abc,mch_def
toolforge tool set invoice-app --mode hybrid                 # cố định trước, dàn chung dự phòng
toolforge tool set invoice-app --mode pinned --no-failover   # chờ đúng máy đó, không chuyển
```

Team ghi đè cấu hình của tool (`"dispatch": { "mode": "pinned", "machines": [...] }`),
và task ghi đè cấu hình của team (`"machines": ["mch_abc"]`). Cấp nào để `inherit`
thì theo cấp trên.

### Cơ chế tự chuyển máy

1. Mỗi agent gửi heartbeat. Quá hạn (mặc định 45 giây) thì hub đánh dấu máy `offline`.
2. Mỗi task đang chạy giữ một **lease**. Khi máy offline — hoặc lease hết hạn,
   hoặc agent báo lỗi — task quay lại hàng đợi và tăng số lần thử.
3. Máy vừa làm rớt task được ghi vào `avoidMachineIds`, nên lần thử sau nó bị xếp
   cuối. Một máy khác nhận task.
4. Hết `maxAttempts` thì task `failed`, và mọi task phụ thuộc nó chuyển sang
   `blocked` thay vì chạy trên một nền tảng đã hỏng.

Đóng laptop giữa chừng cũng không mất việc — việc chỉ chuyển sang máy khác.

### Máy nào được chọn

Ở `auto` và `hybrid`, các máy đủ điều kiện được xếp hạng theo độ tin cậy (có làm
mượt, nên máy mới không bị thiệt vì chưa có lịch sử), số slot trống, tốc độ đo
được, và giá thuê. Máy chỉ đủ điều kiện khi đáp ứng yêu cầu của task:

```jsonc
"requires": {
  "os": "win32", "arch": "x64",
  "tags": ["gpu"], "tools": ["node", "docker"],
  "minMemGb": 8, "minCpus": 4
}
```

Khi có gì đó không chạy và bạn muốn biết vì sao:

```bash
toolforge task why tsk_abc123
#   runnable now   no
#   Blocked by
#    - backend:model is running
#   Machines ruled out
#    old-laptop   missing tool "docker"
#    win-box      os win32 != linux
```

## Phía người cho thuê máy

```bash
toolforge agent capabilities   # máy này quảng bá những gì
toolforge agent status         # slot đang dùng, độ tin cậy, tiền đã kiếm
toolforge earnings --detail    # sổ tính tiền theo từng máy, tính theo phút chạy
```

Giá tính theo phút máy bận (`--price 0.02`), đặt lúc máy tham gia và sửa sau bằng
`toolforge machine set <id> --price`. Hệ thống tính đúng thời gian chạy thật, kể
cả các lần chạy lỗi hoặc bị bỏ dở — chúng được ghi riêng để phân biệt máy chậm
với máy hay rớt.

Chủ máy toàn quyền quyết định cho mượn bao nhiêu: `--slots` của agent là con số
quyết định sau khi kết nối. Dùng `toolforge machine set <id> --status draining` để
máy chạy nốt việc hiện tại rồi ngừng nhận thêm.

## Dashboard

Hub phục vụ một dashboard trực tiếp tại địa chỉ gốc: trạng thái dàn máy, bảng
task theo từng team, và luồng sự kiện chạy liên tục. Nó hỏi admin token một lần
(`toolforge hub token`) rồi lưu trong trình duyệt.

## Bảng lệnh

```
toolforge hub start [--port 7373] [--host 0.0.0.0] [--data-dir DIR]
toolforge hub token                          in ra admin token
toolforge login --hub URL --token TOKEN      trỏ CLI này sang một hub khác

toolforge invite create [--label L] [--max-uses N] [--price P] [--tags a,b]
toolforge invite ls | revoke ID
toolforge agent join --hub URL --code CODE [--name N] [--slots N] [--price P]
toolforge agent start [--hub URL] [--token T] [--slots N]
toolforge agent status | capabilities

toolforge machine ls | show ID | rm ID
toolforge machine add --name N [--tags a,b] [--slots N] [--price P]
toolforge machine set ID [--tags a,b] [--slots N] [--price P] [--status draining]
toolforge machine token ID                   đổi token của máy đó
toolforge earnings [--detail]

toolforge tool lint  -f spec.json
toolforge tool apply -f spec.json [--start] [--force]
toolforge tool ls | show KEY | rm KEY
toolforge tool set KEY --mode pinned|auto|hybrid [--machines a,b] [--no-failover]
toolforge tool start|pause|resume|cancel|retry KEY

toolforge task ls [--tool KEY] [--status running] [--machine ID]
toolforge task show ID | log ID | why ID | retry ID | cancel ID

toolforge status                             tổng quan một màn hình
toolforge watch                              luồng sự kiện trực tiếp
```

Mọi lệnh đều nhận `--json` để script hoá, và `--hub` / `--token` để trỏ sang hub khác.

## Tham chiếu spec của tool

| Trường | Ở đâu | Ý nghĩa |
| --- | --- | --- |
| `key` | tool, team, task | Định danh cố định. Nạp lại spec sẽ cập nhật theo key nên lịch sử task được giữ. |
| `run` / `argv` | task | `run` là chuỗi shell; `argv` là mảng exec (không qua shell). Phải có một trong hai. |
| `dependsOn` | task | `"task-khac"` trong cùng team, hoặc `"team:task"` khác team. Vòng lặp bị từ chối. |
| `concurrency` | tool, team | Số task được chạy đồng thời. |
| `timeoutMs` | task | Quá hạn, agent kill cả nhóm tiến trình; task lỗi với mã 124. |
| `maxAttempts` | task | Tổng số lần thử trên mọi máy trước khi coi là hỏng hẳn. Mặc định 3. |
| `requires` | tool, team, task | Yêu cầu về máy. Cộng dồn: tool + team + task. |
| `machines` | tool, team, task | Danh sách máy cố định. Cấp cụ thể nhất thắng. |
| `env` | tool, team, task | Gộp theo thứ tự tool → team → task, cộng thêm `TOOLFORGE_TASK_REF` và các biến khác. |
| `failoverToPool` | tool, team | Task gắn máy cố định có được tràn sang dàn chung không. Mặc định true. |

Ví dụ chạy được: [`examples/hello-tool.json`](examples/hello-tool.json) (3 task)
và [`examples/web-app-tool.json`](examples/web-app-tool.json) (5 team, 12 task).

## Lưu ý bảo mật

- Hai loại thông tin đăng nhập: một **admin token** cho API điều khiển và
  dashboard, và một **machine token** cho mỗi agent. Machine token chỉ gọi được
  `/api/agent/*` — không đọc được dàn máy, không đụng được việc của máy khác.
- Chỉ lưu hash của token; bản gốc hiện đúng một lần lúc tạo và không endpoint nào
  trả lại. Đổi bằng `toolforge machine token <id>`.
- Mã tham gia có thể giới hạn số lần dùng và thời hạn, và thu hồi bất cứ lúc nào.
- **Agent thực thi các lệnh trong spec của bạn.** Cho thuê máy đồng nghĩa với tin
  tưởng người quản trị hub. Hãy chạy hub trong mạng bạn kiểm soát; mặc định nó chỉ
  lắng nghe `127.0.0.1` trừ khi truyền `--host`, và nó nói HTTP thuần — cần đặt
  TLS phía trước trước khi mở ra Internet.

## Kiến trúc và phát triển

Ghi chú thiết kế, mô hình dữ liệu và giao thức HTTP nằm ở
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```bash
npm test        # 43 test: unit, tích hợp HTTP, và chạy thật end-to-end với agent
```

Giấy phép MIT.
