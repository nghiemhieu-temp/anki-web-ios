# Anki Web iOS (PWA)

Ứng dụng web tối ưu cho **iPhone (iOS Safari)** giúp bạn học và ôn tập flashcard từ các file `.apkg` của Anki trực tiếp trên trình duyệt hoặc cài đặt thành App trên Màn hình chính (PWA), hỗ trợ **100% Offline**.

---

## ✨ Tính năng nổi bật

1. **Đọc trực tiếp file `.apkg`**:
   - Sử dụng `JSZip` và `sql.js` (SQLite WebAssembly) chạy hoàn toàn trên trình duyệt iPhone.
   - Không cần upload file lên bất kỳ server nào — bảo mật 100% dữ liệu cá nhân.
   - Hỗ trợ giải nén và phát hình ảnh, âm thanh phát âm (`[sound:...]`).
   - Tự động xử lý thẻ đục lỗ (Cloze deletion `{{c1::...}}`).

2. **Giao diện tối ưu cho màn hình iPhone (iOS Look & Feel)**:
   - Hoạt ảnh lật thẻ 3D mượt mà (3D Card Flip).
   - Thao tác cảm ứng tiện lợi: Chạm thẻ để lật, vuốt sang trái/phải để chuyển thẻ.
   - Nút đánh giá lặp lại ngắt quãng (SRS): **Học lại (< 1m), Khó (1d), Tốt (3d), Dễ (5d)**.
   - Phím tắt bàn phím (Space / 1-4) nếu kết nối bàn phím ngoài với iPad/iPhone/Máy tính.

3. **Lưu trữ Offline với IndexedDB & Service Worker**:
   - Sau khi nạp file `.apkg`, dữ liệu được lưu vĩnh viễn trong bộ nhớ trình duyệt iPhone.
   - Bật Chế độ máy bay (không có mạng) vẫn mở ra học bình thường.

4. **Có sẵn Bộ thẻ mẫu (Demo Deck)**:
   - Thử nghiệm ngay lập tức các tính năng mà không cần chuẩn bị file `.apkg` trước.

---

## 🚀 Cách chạy thử nghiệm ngay

### Cách 1: Chạy Server nội bộ và mở trên iPhone qua Wi-Fi
Trong cùng mạng Wi-Fi với iPhone:
1. Mở PowerShell hoặc Terminal tại thư mục `anki-web-ios`:
   ```bash
   cd C:\Users\nghie\.gemini\antigravity\scratch\anki-web-ios
   python -m http.server 8080 --bind 0.0.0.0
   ```
2. Tìm địa chỉ IP của máy tính (chạy lệnh `ipconfig` trên Windows, ví dụ `192.168.1.15`).
3. Mở Safari trên iPhone và truy cập:
   ```
   http://192.168.1.15:8080
   ```

---

### Cách 2: Triển khai (Deploy) Online Miễn phí (Khuyên dùng để cài làm App)
Để iPhone cho phép **"Thêm vào Màn hình chính" (Add to Home Screen)** và dùng như một app thực thụ, web app cần chạy qua giao thức HTTPS.

Bạn có thể đưa toàn bộ thư mục này lên các dịch vụ hosting tĩnh miễn phí:
* **Vercel**: Kéo thả thư mục `anki-web-ios` vào [vercel.com](https://vercel.com) hoặc dùng lệnh `npx vercel`.
* **GitHub Pages**: Đẩy code lên GitHub -> Settings -> Pages -> Chọn nhánh `main`.
* **Cloudflare Pages** hoặc **Netlify**: Kéo thả thư mục để deploy trong 10 giây.

---

## 📱 Cách cài đặt thành App trên iPhone
1. Mở link web app bằng **Safari** trên iPhone.
2. Nhấn nút **Chia sẻ (Share)** ở thanh điều hướng dưới cùng của Safari (biểu tượng ô vuông có mũi tên lên `⎋`).
3. Cuộn xuống chọn **"Thêm vào MH chính" (Add to Home Screen)**.
4. Bấm **Thêm (Add)** ở góc trên. 
5. Biểu tượng **AnkiWeb** sẽ xuất hiện trên màn hình iPhone, bấm vào sẽ mở toàn màn hình (không có thanh URL của trình duyệt) và dùng được khi không có mạng!
