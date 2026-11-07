# ระบบจองรถราชการออนไลน์

ระบบขอใช้รถราชการ จัดสรรรถและพนักงานขับรถ เห็นชอบ/อนุมัติ ลงลายมือชื่ออิเล็กทรอนิกส์ พิมพ์แบบ ๓ และรายงานผลการใช้รถ

## โครงสร้าง

```
index.html            หน้าเว็บ (โฮสต์บน GitHub Pages หรือเว็บโฮสต์ใดก็ได้)
config.js             ตั้งค่า API_URL ชี้ไปยัง Apps Script
apps-script/
  code.gs             ระบบหลังบ้าน (Google Apps Script) เก็บข้อมูลใน Google Sheets / Drive
  appsscript.json     manifest ของ Apps Script
```

หน้าเว็บส่งคำขอ `POST {fn, args}` ไปยัง Apps Script Web App ซึ่งตอบกลับเป็น JSON
ข้อมูลทั้งหมดยังอยู่ใน Google Sheets และ Google Drive ของผู้ติดตั้ง

---

## ขั้นที่ 1 ติดตั้งหลังบ้าน (Google Apps Script)

1. ไปที่ <https://script.google.com> → **New project** ตั้งชื่อ เช่น `ระบบจองรถราชการ`
2. วางเนื้อหา `apps-script/code.gs` ลงในไฟล์ `Code.gs`
3. (ทางเลือก) สร้างไฟล์ HTML ชื่อ `index` แล้ววางเนื้อหา `index.html` เพื่อให้เปิดผ่าน URL ของ Apps Script ได้ด้วย
4. **Project Settings** (รูปเฟือง) → ติ๊ก *Show "appsscript.json"* แล้ววางเนื้อหา `apps-script/appsscript.json` (เวลา Asia/Bangkok)
5. ตั้งค่า **Script Properties** (Project Settings → Script Properties)

   | Property | ความหมาย |
   |---|---|
   | `SPREADSHEET_ID` | ID ของ Google Sheets ที่ใช้เป็นฐานข้อมูล |
   | `CAR_PHOTO_FOLDER_ID` | โฟลเดอร์ Drive เก็บรูปก่อนเดินทาง |
   | `RETURN_PHOTO_FOLDER_ID` | โฟลเดอร์ Drive เก็บรูปหลังเดินทาง |
   | `SIGNATURE_FOLDER_ID` | โฟลเดอร์ลายเซ็น (ห้ามแชร์) |

   > **ติดตั้งใหม่:** เว้นว่างได้ทั้งหมด ระบบจะสร้างสเปรดชีตและโฟลเดอร์ให้เองในขั้นถัดไป
   > **ย้ายจากระบบเดิม:** ใส่ ID เดิม เพื่อใช้ข้อมูลชุดเดิมต่อ
   > ID คือส่วนใน URL เช่น `docs.google.com/spreadsheets/d/`**`ID`**`/edit`

6. เลือกฟังก์ชัน `setupSystem` แล้วกด **Run** (อนุญาตสิทธิ์เมื่อระบบถาม)
   ดูผลใน Execution log จะมีลิงก์สเปรดชีตและรายชื่อบัญชีตัวอย่าง (รหัสผ่านเริ่มต้น `Pass@1234` ระบบบังคับเปลี่ยนเมื่อเข้าครั้งแรก)

## ขั้นที่ 2 Deploy เป็น Web App

1. **Deploy → New deployment** → ประเภท **Web app**
2. *Execute as:* **Me** — *Who has access:* **Anyone**
3. กด Deploy แล้วคัดลอก **Web app URL** (ลงท้ายด้วย `/exec`)
4. ทดสอบเปิด `URL?ping=1` ในเบราว์เซอร์ ต้องเห็น `{"ok":true,...}`

> เมื่อแก้ไข `code.gs` ภายหลัง ต้อง **Deploy → Manage deployments → แก้ไข (ดินสอ) → Version: New version** เพื่อให้ URL เดิมใช้โค้ดใหม่

## ขั้นที่ 3 ตั้งค่าหน้าเว็บ

แก้ไฟล์ `config.js`

```js
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/xxxxxxxx/exec"
};
```

## ขั้นที่ 4 ขึ้น GitHub และเปิด GitHub Pages

```bash
git init
git add .
git commit -m "ระบบจองรถราชการออนไลน์"
git branch -M main
git remote add origin https://github.com/<ชื่อผู้ใช้>/<ชื่อ-repo>.git
git push -u origin main
```

จากนั้นที่ GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)`** → Save
รอสักครู่ จะได้ลิงก์ `https://<ชื่อผู้ใช้>.github.io/<ชื่อ-repo>/`

### โฮสต์อื่น
`index.html` และ `config.js` เป็นไฟล์ static ล้วน อัปโหลดขึ้น Netlify, Vercel, Cloudflare Pages หรือเว็บโฮสต์ทั่วไปได้ทันที (ต้องเปิดผ่าน https)

---

## ความปลอดภัย
- รหัสผ่านเก็บแบบ SHA-256 + Salt และตรวจสิทธิ์ทุกคำสั่งที่ฝั่งเซิร์ฟเวอร์
- Web App เรียกได้เฉพาะฟังก์ชันในรายการ `API_FUNCTIONS` (ใน `code.gs`) เท่านั้น
- ไม่ต้องเก็บ ID ของ Sheets/Drive ไว้ใน repo เพราะอ่านจาก Script Properties
- ไม่ควรแชร์โฟลเดอร์ลายเซ็นใน Drive

## แก้ปัญหา
| อาการ | วิธีแก้ |
|---|---|
| หน้า login แจ้ง "ยังไม่ได้ตั้งค่า API_URL" | ใส่ URL ใน `config.js` แล้ว push ใหม่ |
| "เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง" | Deploy ใหม่โดยเลือก *Who has access: Anyone* และใช้ URL ที่ลงท้าย `/exec` |
| "ยังไม่ได้ตั้งค่าฐานข้อมูล" | รัน `setupSystem` ใน Apps Script หรือใส่ `SPREADSHEET_ID` ใน Script Properties |
| แก้โค้ดแล้วไม่เปลี่ยน | Deploy เป็น *New version* และกด Ctrl+F5 ที่หน้าเว็บ |
