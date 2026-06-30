# RouterDone

OpenAI-compatible local AI gateway and routing dashboard. Add upstream providers, create routing combos, expose `/v1/*` endpoints, and route helper models through a neutral fallback combo.

**Language / Ngôn ngữ:** [English](#english) · [Tiếng Việt](#tiếng-việt)

---

## English

RouterDone is an OpenAI-compatible local AI gateway and routing dashboard. Add upstream providers, create routing combos, expose `/v1/*` endpoints, and route helper models through a neutral fallback combo.

### One-Line Install

Linux / macOS (auto-clones, generates secrets, starts Docker):

```bash
curl -fsSL https://raw.githubusercontent.com/thoa100m/routerdone/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/thoa100m/routerdone/main/install.ps1 | iex
```

Options: `PORT` (default 20128), `DIR` (default routerdone), `INITIAL_PASSWORD` (auto if unset). The admin password is printed at the end if it was auto-generated. Full per-scenario detail: `docs/INSTALL.md`.

### Install Guide

Detailed, step-by-step install for each scenario lives in `docs/INSTALL.md`:

- Personal computer (Docker): `docs/INSTALL.md` Scenario A
- VPS / server (Docker, public + HTTPS): `docs/INSTALL.md` Scenario B
- Dokploy (managed Compose): `docs/INSTALL.md` Scenario C and `docs/DOKPLOY.md`
- Local development from source: `docs/INSTALL.md` Scenario D
- Versions and updating: `docs/INSTALL.md` Versions And Updating

The sections below are a fast path. Use the install guide for full per-scenario detail.

### Quick Start With Docker Compose

1. Create an `.env` file:

```bash
cp .env.example .env
```

2. Replace the required secrets:

```bash
JWT_SECRET=$(openssl rand -hex 32)
INITIAL_PASSWORD=change-this-admin-password
API_KEY_SECRET=$(openssl rand -hex 32)
MACHINE_ID_SALT=$(openssl rand -hex 32)
```

On Windows PowerShell:

```powershell
$env:JWT_SECRET = -join ((1..64) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })
```

3. Start RouterDone:

```bash
docker compose up --build -d
```

4. Open:

```text
http://localhost:20128/admin
```

5. Health check:

```bash
curl http://localhost:20128/api/health
```

### Local Development

```bash
npm install
npm run dev
```

Default dev URL:

```text
http://localhost:20128
```

Production build:

```bash
npm run build
npm run start
```

### First Login And Usage

After install, here is how to sign in and start using RouterDone.

1. Open the app in your browser:

```text
http://localhost:20128/admin
```

2. You land on the login page. Sign in with the admin password (`INITIAL_PASSWORD`). If the installer auto-generated it, the password was printed at the end of the install output.

3. The dashboard opens. The sidebar lists the main areas: **Providers**, **Combos**, **Usage**, **Keys**, **CLI Tools**, **MITM**, **Profile**.

4. Add a provider: open **Providers -> New**, enter the upstream base URL and API key, then save. Select the models you want to expose.

5. Create a combo: open **Combos -> New**, give it a name (for example `helper.fallback`), add one or more models from your providers, and set the fallback order.

6. Create an API key: open **Keys** (or **Profile**), create a key, and copy it. This is the `YOUR_ROUTERDONE_API_KEY` your clients will use.

7. Optional: set up Model Redirect in **Dashboard -> Profile -> Model Redirect** and point auxiliary model names at `helper.fallback`.

8. Call the OpenAI-compatible endpoint with that key:

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer YOUR_ROUTERDONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-provider/your-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Model Redirect

RouterDone supports model redirects for helper or auxiliary model names. A redirect maps one incoming model name to another model or combo.

Public default:

```text
gpt-5.4-mini -> helper.fallback
```

Recommended setup:

1. Add one or more providers.
2. Create a combo named `helper.fallback`.
3. Put a cheap, available helper model in that combo.
4. Open `Dashboard -> Profile -> Model Redirect`.
5. Keep or add redirects that point auxiliary models to `helper.fallback`.

Use neutral combo names such as `helper.fallback`, `coding.fallback`, or `vision.fallback`.

### Vision Preprocessing

RouterDone can convert image blocks in a request into OCR text before the request reaches a model that has no vision support, so non-vision models can still answer questions about images.

How it works:

1. A chat request contains `image_url` / `image` content blocks.
2. Before combo dispatch, RouterDone calls a vision-capable model (default `oc/mimo-v2.5-free`) via self-loopback to read each image and return an OCR + brief description.
3. Image blocks in the last user message are replaced with `[Image description: ...]` text; images in older turns are stripped without a vision call.
4. The body now contains only text, so any model in the combo can understand it.

Skip rules:

- If the target model already supports vision (per `getCapabilitiesForModel`), preprocessing is skipped and the model reads the raw image directly — no quality downgrade.
- A `_skipVision` flag on the self-loopback request prevents infinite recursion.
- If the vision call fails or times out (30s), the original body passes through and the normal modality-stripping in chatCore handles the images. Vision preprocessing is non-fatal.

Configuration:

1. Open `Dashboard -> Profile -> Vision Preprocessing`.
2. Toggle preprocessing on/off.
3. Pick or enter a vision model string in `provider/model` form (e.g. `oc/mimo-v2.5-free`).

The vision model is instructed to only read the image — it never answers the user's question.

### Docker Compose

The included `docker-compose.yml` persists:

```text
/app/data
/app/data-home
```

Required env vars:

```text
JWT_SECRET
INITIAL_PASSWORD
API_KEY_SECRET
MACHINE_ID_SALT
```

Common env vars:

```text
PORT=20128
NODE_ENV=production
TZ=UTC
BASE_URL=http://localhost:20128
NEXT_PUBLIC_BASE_URL=http://localhost:20128
REQUIRE_API_KEY=false
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
```

### Dokploy

Use the repository as a Docker Compose app in Dokploy.

1. Create a new Dokploy application.
2. Select Docker Compose.
3. Use `docker-compose.yml`.
4. Set environment variables from `.env.example`.
5. Set `BASE_URL` and `NEXT_PUBLIC_BASE_URL` to your public app URL.
6. Use persistent volumes for `/app/data` and `/app/data-home`.
7. Deploy, then verify `/api/health`.

For public HTTPS deployments:

```text
AUTH_COOKIE_SECURE=true
REQUIRE_API_KEY=true
BASE_URL=https://your-domain.example
NEXT_PUBLIC_BASE_URL=https://your-domain.example
```

### Build

```bash
docker build -t routerdone .
docker run --rm -p 20128:20128 --env-file .env \
  -v routerdone-data:/app/data \
  -v routerdone-data-home:/app/data-home \
  routerdone
```

Smoke test:

```bash
curl http://localhost:20128/api/health
curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_ROUTERDONE_API_KEY"
```

### License

MIT. Keep upstream attribution in `LICENSE`.

### Credits

RouterDone is rebuilt as a clean public distribution under the RouterDone brand.

It adds and ships extra improvements: progressive/scored request token compression (RTK), provider auto-heal, quota auto-manage, adaptive timeouts, runtime observability, combo stream-error fallback, tool-call argument sanitization, output-text normalization, and a configurable Model Redirect for helper/auxiliary models.

License and attribution are preserved in `LICENSE`.

---

## Tiếng Việt

RouterDone là cổng gateway AI nội bộ tương thích OpenAI và bảng điều khiển định tuyến. Bạn có thể thêm provider upstream, tạo combo định tuyến, mở các endpoint `/v1/*`, và định tuyến model phụ trợ qua combo fallback trung lập.

### Cài đặt một dòng

Linux / macOS (tự clone, tạo secret, khởi động Docker):

```bash
curl -fsSL https://raw.githubusercontent.com/thoa100m/routerdone/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/thoa100m/routerdone/main/install.ps1 | iex
```

Tùy chọn: `PORT` (mặc định 20128), `DIR` (mặc định routerdone), `INITIAL_PASSWORD` (tự sinh nếu để trống). Mật khẩu quản trị được in ở cuối nếu được tự sinh. Chi tiết theo từng trường hợp xem tại `docs/INSTALL.md`.

### Hướng dẫn cài đặt

Hướng dẫn cài đặt chi tiết từng bước cho từng trường hợp nằm trong `docs/INSTALL.md`:

- Máy cá nhân (Docker): `docs/INSTALL.md` Scenario A
- VPS / server (Docker, public + HTTPS): `docs/INSTALL.md` Scenario B
- Dokploy (Compose quản lý): `docs/INSTALL.md` Scenario C và `docs/DOKPLOY.md`
- Phát triển cục bộ từ mã nguồn: `docs/INSTALL.md` Scenario D
- Phiên bản và cập nhật: `docs/INSTALL.md` Versions And Updating

Phần dưới đây là đường tắt. Dùng hướng dẫn cài đặt để có chi tiết đầy đủ theo từng trường hợp.

### Khởi động nhanh với Docker Compose

1. Tạo file `.env`:

```bash
cp .env.example .env
```

2. Thay các secret bắt buộc:

```bash
JWT_SECRET=$(openssl rand -hex 32)
INITIAL_PASSWORD=change-this-admin-password
API_KEY_SECRET=$(openssl rand -hex 32)
MACHINE_ID_SALT=$(openssl rand -hex 32)
```

Trên Windows PowerShell:

```powershell
$env:JWT_SECRET = -join ((1..64) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })
```

3. Khởi động RouterDone:

```bash
docker compose up --build -d
```

4. Mở:

```text
http://localhost:20128/admin
```

5. Kiểm tra sức khỏe:

```bash
curl http://localhost:20128/api/health
```

### Phát triển cục bộ

```bash
npm install
npm run dev
```

URL dev mặc định:

```text
http://localhost:20128
```

Build production:

```bash
npm run build
npm run start
```

### Đăng nhập và sử dụng sau khi cài

Sau khi cài xong, đây là cách đăng nhập và bắt đầu dùng RouterDone.

1. Mở ứng dụng trong trình duyệt:

```text
http://localhost:20128/admin
```

2. Bạn sẽ thấy trang đăng nhập. Đăng nhập bằng mật khẩu quản trị (`INITIAL_PASSWORD`). Nếu trình cài đặt tự sinh mật khẩu, nó đã được in ở cuối output cài đặt.

3. Dashboard mở ra. Thanh bên có các khu vực chính: **Providers**, **Combos**, **Usage**, **Keys**, **CLI Tools**, **MITM**, **Profile**.

4. Thêm provider: mở **Providers -> New**, nhập upstream base URL và API key, rồi lưu. Chọn các model bạn muốn mở.

5. Tạo combo: mở **Combos -> New**, đặt tên (ví dụ `helper.fallback`), thêm một hoặc nhiều model từ provider, và thiết lập thứ tự fallback.

6. Tạo API key: mở **Keys** (hoặc **Profile**), tạo key và sao chép. Đây là `YOUR_ROUTERDONE_API_KEY` mà các client của bạn sẽ dùng.

7. Tùy chọn: thiết lập Model Redirect trong **Dashboard -> Profile -> Model Redirect** và trỏ các tên model phụ trợ tới `helper.fallback`.

8. Gọi endpoint tương thích OpenAI với key đó:

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer YOUR_ROUTERDONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-provider/your-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Model Redirect

RouterDone hỗ trợ chuyển hướng model cho các tên model phụ trợ. Một redirect ánh xạ tên model đầu vào sang một model hoặc combo khác.

Mặc định công khai:

```text
gpt-5.4-mini -> helper.fallback
```

Thiết lập khuyến nghị:

1. Thêm một hoặc nhiều provider.
2. Tạo combo tên `helper.fallback`.
3. Đặt một model phụ trợ rẻ và sẵn có vào combo đó.
4. Mở `Dashboard -> Profile -> Model Redirect`.
5. Giữ hoặc thêm redirect trỏ model phụ trợ tới `helper.fallback`.

Dùng tên combo trung lập như `helper.fallback`, `coding.fallback`, hoặc `vision.fallback`.

### Vision Preprocessing (Tiền xử lý ảnh)

RouterDone có thể chuyển các khối ảnh trong request thành văn bản OCR trước khi request tới model không hỗ trợ đọc ảnh, giúp các model non-vision vẫn trả lời được câu hỏi về ảnh.

Cách hoạt động:

1. Một chat request chứa khối nội dung `image_url` / `image`.
2. Trước khi dispatch combo, RouterDone gọi một model hỗ trợ vision (mặc định `oc/mimo-v2.5-free`) qua self-loopback để đọc từng ảnh và trả về OCR + mô tả ngắn.
3. Các khối ảnh trong tin nhắn user cuối cùng được thay bằng văn bản `[Image description: ...]`; ảnh ở các lượt cũ bị gỡ bỏ mà không gọi vision model.
4. Body lúc này chỉ còn văn bản, nên mọi model trong combo đều hiểu được.

Quy tắc bỏ qua:

- Nếu model đích đã hỗ trợ vision (theo `getCapabilitiesForModel`), bỏ qua tiền xử lý và để model đọc ảnh gốc trực tiếp — không giảm chất lượng.
- Cờ `_skipVision` trên request self-loopback ngăn đệ quy vô hạn.
- Nếu lệnh gọi vision thất bại hoặc hết thời gian (30s), body gốc được truyền qua và bước modality-stripping thông thường trong chatCore xử lý ảnh. Tiền xử lý vision là non-fatal.

Cấu hình:

1. Mở `Dashboard -> Profile -> Vision Preprocessing`.
2. Bật/tắt tiền xử lý.
3. Chọn hoặc nhập chuỗi vision model dạng `provider/model` (ví dụ `oc/mimo-v2.5-free`).

Vision model được hướng dẫn chỉ đọc ảnh — không bao giờ trả lời câu hỏi của user.

### Docker Compose

File `docker-compose.yml` đi kèm lưu trữ:

```text
/app/data
/app/data-home
```

Biến môi trường bắt buộc:

```text
JWT_SECRET
INITIAL_PASSWORD
API_KEY_SECRET
MACHINE_ID_SALT
```

Biến môi trường phổ biến:

```text
PORT=20128
NODE_ENV=production
TZ=UTC
BASE_URL=http://localhost:20128
NEXT_PUBLIC_BASE_URL=http://localhost:20128
REQUIRE_API_KEY=false
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
```

### Dokploy

Dùng repo như một ứng dụng Docker Compose trong Dokploy.

1. Tạo ứng dụng Dokploy mới.
2. Chọn Docker Compose.
3. Dùng `docker-compose.yml`.
4. Đặt biến môi trường từ `.env.example`.
5. Đặt `BASE_URL` và `NEXT_PUBLIC_BASE_URL` thành URL công khai của app.
6. Dùng volume cố định cho `/app/data` và `/app/data-home`.
7. Triển khai, rồi kiểm tra `/api/health`.

Cho triển khai HTTPS công khai:

```text
AUTH_COOKIE_SECURE=true
REQUIRE_API_KEY=true
BASE_URL=https://your-domain.example
NEXT_PUBLIC_BASE_URL=https://your-domain.example
```

### Build

```bash
docker build -t routerdone .
docker run --rm -p 20128:20128 --env-file .env \
  -v routerdone-data:/app/data \
  -v routerdone-data-home:/app/data-home \
  routerdone
```

Kiểm tra nhanh:

```bash
curl http://localhost:20128/api/health
curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_ROUTERDONE_API_KEY"
```

### Giấy phép

MIT. Giữ attribution upstream trong `LICENSE`.

### Ghi nhận

RouterDone được dựng lại thành bản phân phối công khai sạch dưới thương hiệu RouterDone.

RouterDone thêm và phát hành các cải tiến: nén token request dạng progressive/scored (RTK), tự phục hồi provider, tự quản lý quota, timeout thích ứng, quan sát runtime, fallback lỗi stream combo, làm sạch tham số tool-call, chuẩn hóa output-text, và Model Redirect cấu hình được cho các model phụ trợ.

Giấy phép và attribution được giữ trong `LICENSE`.
