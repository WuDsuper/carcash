/**
 * ระบบจองรถราชการออนไลน์ (Government Vehicle Booking System)
 * Backend Script (Google Apps Script) เวอร์ชัน 2.0
 *
 * ความสามารถหลัก
 * 1. ระบบเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่าน (เข้ารหัสแบบ SHA-256 + Salt)
 * 2. แบ่งสิทธิ์ตามบทบาท 4 ระดับ ได้แก่ admin (งานยานพาหนะ), director (ผู้บริหาร/ผู้อนุมัติ),
 *    driver (พนักงานขับรถ), user (ผู้ขอใช้รถ) โดยตรวจสิทธิ์ที่ฝั่งเซิร์ฟเวอร์ทุกฟังก์ชัน
 * 3. ตรวจสอบรถและพนักงานขับรถว่างตามช่วงเวลา ป้องกันการจัดสรรซ้อน
 * 4. บันทึกประวัติการใช้งาน (Logs) ทุกการดำเนินการสำคัญ
 * 5. ลงลายมือชื่ออิเล็กทรอนิกส์ 2 แบบ คือ ลายเซ็นสแกนประจำตัว และการลงนามบนอุปกรณ์
 *    ไฟล์ลายเซ็นเก็บใน Google Drive แบบไม่แชร์สาธารณะ แสดงผลผ่านระบบตามสิทธิ์เท่านั้น
 *
 * วิธีติดตั้งครั้งแรก: เลือกฟังก์ชัน setupSystem แล้วกด Run หนึ่งครั้ง
 */

/* ---------------------------------------------------------------------
 * การตั้งค่า ID ของ Google Sheets / Drive
 * แนะนำให้ตั้งใน Project Settings > Script Properties (ไม่ต้องเก็บ ID ไว้ในโค้ดบน GitHub)
 *   SPREADSHEET_ID, CAR_PHOTO_FOLDER_ID, RETURN_PHOTO_FOLDER_ID, SIGNATURE_FOLDER_ID
 * ถ้าไม่ตั้ง ระบบจะใช้ค่าด้านล่าง และถ้ายังว่าง จะสร้างสเปรดชีต/โฟลเดอร์ให้อัตโนมัติเมื่อรัน setupSystem
 * --------------------------------------------------------------------- */
const DEFAULT_IDS = {
  SPREADSHEET_ID: "",
  CAR_PHOTO_FOLDER_ID: "",     // รูปภาพก่อนเดินทาง
  RETURN_PHOTO_FOLDER_ID: "",  // รูปภาพหลังเดินทาง
  SIGNATURE_FOLDER_ID: ""      // โฟลเดอร์เก็บลายเซ็น (ห้ามแชร์)
};
const FOLDER_NAMES = {
  CAR_PHOTO_FOLDER_ID: 'รูปภาพก่อนเดินทาง ระบบจองรถราชการ',
  RETURN_PHOTO_FOLDER_ID: 'รูปภาพหลังเดินทาง ระบบจองรถราชการ',
  SIGNATURE_FOLDER_ID: 'ลายเซ็น ระบบจองรถราชการ (ห้ามแชร์)'
};

// การบังคับลงลายมือชื่อในแต่ละขั้นตอน (true = ต้องลงนาม)
const SIGN_REQUIRED = { request: false, assign: false, endorse: true, approve: true, acknowledge: true, handover: true };

// ข้อความบนแบบ ๓ ใบขออนุญาตใช้รถยนต์ส่วนกลาง (แก้ไขให้ตรงกับหน่วยงาน)
const FORM3 = {
  orgFull: "สำนักงานเขตพื้นที่การศึกษาประถมศึกษานครศรีธรรมราช เขต 1",
  addressee: "ผู้อำนวยการสำนักงานเขตพื้นที่การศึกษาประถมศึกษานครศรีธรรมราช เขต 1",
  orgShort: "สพป.นศ.เขต 1",
  fundAgency: "สพป.นศ.1"
};
const FUEL_TYPES = ["โซล่า", "เบนซิน"];
const ORDER_TYPES = ["อนุญาต", "อนุมัติ"];

const APP_NAME = "ระบบจองรถราชการออนไลน์";
const ORG_NAME = "สพป.นครศรีธรรมราช เขต 1";
const DEFAULT_PASSWORD = "Pass@1234";       // รหัสผ่านเริ่มต้นของบัญชีตัวอย่าง (ระบบบังคับเปลี่ยนเมื่อเข้าครั้งแรก)
const SESSION_SECONDS = 6 * 60 * 60;         // อายุเซสชัน 6 ชั่วโมง (นับต่อเนื่องเมื่อมีการใช้งาน)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;
const HASH_ROUNDS = 100;

const ROLE_LABELS = {
  admin: "ผู้ดูแลระบบ",
  fleet: "หัวหน้างานยานพาหนะ",
  supervisor: "เจ้าหน้าที่ / ผู้อำนวยการกลุ่ม",
  clerk: "เจ้าหน้าที่ธุรการ",
  director: "ผู้อำนวยการ (ผู้อนุมัติ)",
  driver: "พนักงานขับรถ",
  user: "ผู้ขอใช้รถ"
};
const STAFF_ROLES = ['admin', 'fleet', 'supervisor', 'director', 'clerk']; // เห็นคำขอทั้งหมด
const FLEET_ROLES = ['fleet', 'admin'];                                  // จัดรถ จัดการรถและพนักงานขับรถ
const REQUESTER_ROLES = ['user', 'supervisor', 'director', 'fleet', 'clerk', 'admin']; // ยื่นคำขอได้
const CHANGE_ROLES = ['fleet', 'clerk'];                                  // ยกเลิกการใช้รถ และเปลี่ยนวันเวลาเดินทาง ได้เท่านั้น
const VEHICLE_CONDITIONS = ['ปกติ', 'ชำรุดเล็กน้อย', 'ต้องซ่อมบำรุง'];
const TRIP_RESULTS = ['เรียบร้อยตามกำหนด', 'มีเหตุขัดข้อง'];

const ST = {
  WAIT_FLEET: "รอหัวหน้ายานพิจารณา",
  WAIT_ENDORSE: "รอเห็นชอบ",
  WAIT_APPROVE: "รอผู้อำนวยการอนุมัติ",
  APPROVED: "อนุมัติแล้ว",
  ACTIVE: "กำลังใช้งาน",
  DONE: "เสร็จสิ้น",
  REJECTED: "ไม่อนุมัติ",
  CANCELLED: "ยกเลิก"
};
// สถานะที่ถือว่าจองรถและพนักงานขับรถไว้แล้ว
const HOLD_STATUSES = [ST.WAIT_ENDORSE, ST.WAIT_APPROVE, ST.APPROVED, ST.ACTIVE];
// สถานะจากเวอร์ชันก่อน ระบบจะแปลงให้เมื่อรัน setupSystem
const LEGACY_STATUS = { "รออนุมัติ": ST.WAIT_FLEET, "รอจัดสรรรถ": ST.WAIT_FLEET };

const SCHEMA = {
  Requests: [
    "เลขที่คำขอ", "วันที่ยื่นคำขอ", "ชื่อผู้ขอ", "ตำแหน่ง", "กลุ่มงาน", "เบอร์โทร",
    "วัตถุประสงค์", "สถานที่ปลายทาง", "จังหวัด", "วันที่เดินทาง", "เวลาเดินทาง",
    "วันที่กลับ", "เวลากลับ", "จำนวนผู้โดยสาร", "รายชื่อผู้ร่วมเดินทาง",
    "สถานะ", "รถยนต์ที่จัดสรร", "พนักงานขับรถ",
    "เลขไมล์ก่อนเดินทาง", "ระดับน้ำมันก่อนเดินทาง", "รูปภาพก่อนเดินทาง",
    "เลขไมล์หลังเดินทาง", "ระยะทางรวม", "ค่าน้ำมัน", "ค่าทางด่วน", "ค่าใช้จ่ายอื่น", "รูปภาพหลังใช้งาน",
    // คอลัมน์ที่เพิ่มในเวอร์ชัน 2.0 (ระบบจะเติมต่อท้ายชีตเดิมให้อัตโนมัติ)
    "ระดับน้ำมันหลังเดินทาง", "ชื่อผู้ใช้ผู้ขอ", "รหัสรถ", "รหัสพนักงานขับรถ",
    "ผู้อนุมัติ", "วันเวลาอนุมัติ", "ความเห็นผู้อนุมัติ",
    "ผู้จัดสรรรถ", "วันเวลาจัดสรร", "วันเวลาออกเดินทางจริง", "วันเวลากลับถึงจริง", "หมายเหตุ",
    // ลายมือชื่อ (เก็บรหัสไฟล์ใน Drive และวิธีลงนาม)
    "ลายเซ็นผู้ขอ", "วิธีลงนามผู้ขอ", "ลายเซ็นผู้อนุมัติ", "วิธีลงนามผู้อนุมัติ", "ลายเซ็นผู้จัดสรรรถ", "วิธีลงนามผู้จัดสรรรถ",
    // ข้อมูลตามแบบ ๓
    "หัวหน้าคณะ", "แหล่งงบประมาณน้ำมัน", "ชื่อโครงการ", "แผนปฏิบัติงานประจำปี",
    "ชนิดน้ำมันที่อนุญาต", "วงเงินน้ำมัน", "ใบสั่งซื้อเล่มที่", "ใบสั่งซื้อเลขที่", "ตำแหน่งผู้จัดสรรรถ",
    "ชื่อผู้อนุมัติ", "ตำแหน่งผู้อนุมัติ", "คำสั่งผู้อนุมัติ",
    "ลายเซ็นพนักงานขับรถ", "วิธีลงนามพนักงานขับรถ", "วันเวลารับทราบ",
    // ลำดับขั้นตอน 5 ขั้น
    "ความเห็นผู้จัดสรรรถ", "ผู้เห็นชอบ", "ตำแหน่งผู้เห็นชอบ", "วันเวลาเห็นชอบ", "ความเห็นผู้เห็นชอบ",
    "ลายเซ็นผู้เห็นชอบ", "วิธีลงนามผู้เห็นชอบ", "ขั้นตอนที่ไม่ผ่าน", "ส่งคืนกุญแจและเอกสาร",
    // รายงานผลการใช้รถ และการยกเลิก/เปลี่ยนแปลง
    "ลายเซ็นส่งมอบงาน", "วิธีลงนามส่งมอบงาน", "สภาพรถหลังใช้งาน", "ผลการปฏิบัติงาน",
    "ผู้ยกเลิก", "เหตุผลการยกเลิก", "วันเวลายกเลิก", "ประวัติการเปลี่ยนแปลง", "คำร้องขอเปลี่ยนแปลง", "วันเวลาคำร้อง"
  ],
  Vehicles: ["รหัสรถ", "ทะเบียนรถ", "ยี่ห้อ/รุ่น", "ประเภทรถ", "จำนวนที่นั่ง", "สถานะ", "รูปภาพรถ", "เลขไมล์ล่าสุด", "หมายเหตุ", "ชนิดเชื้อเพลิง"],
  Drivers: ["รหัสพนักงาน", "ชื่อ-นามสกุล", "เบอร์โทร", "ประเภทใบอนุญาต", "วันหมดอายุใบอนุญาต", "สถานะ"],
  Users: [
    "ชื่อผู้ใช้", "รหัสผ่าน(เข้ารหัส)", "Salt", "ชื่อ-นามสกุล", "ตำแหน่ง", "กลุ่มงาน", "เบอร์โทร", "อีเมล",
    "บทบาท", "รหัสพนักงานขับรถ", "สถานะ", "ต้องเปลี่ยนรหัสผ่าน", "เข้าสู่ระบบล่าสุด", "วันที่สร้าง", "ไฟล์ลายเซ็น"
  ],
  Logs: ["วันเวลา", "ชื่อผู้ใช้", "ชื่อ-นามสกุล", "บทบาท", "การดำเนินการ", "รายละเอียด"]
};

const VEHICLE_STATUS = ["พร้อมใช้งาน", "อยู่ระหว่างใช้งาน", "ซ่อมบำรุง", "เลิกใช้งาน"];
const DRIVER_STATUS = ["พร้อมปฏิบัติงาน", "กำลังปฏิบัติงาน", "ลา/ไม่พร้อมปฏิบัติงาน", "พ้นจากหน้าที่"];

/* =====================================================================
 * 1. Web App
 * ===================================================================== */

// เปิดผ่าน URL ของ Apps Script โดยตรง (ทางเลือกสำรอง) หรือ ?ping=1 เพื่อตรวจสอบ API
function doGet(e) {
  if (e && e.parameter && e.parameter.ping) {
    return json_({ ok: true, data: { app: APP_NAME, org: ORG_NAME, time: now_() } });
  }
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(APP_NAME + ' ' + ORG_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ---------------------------------------------------------------------
 * JSON API สำหรับหน้าเว็บที่โฮสต์ภายนอก (เช่น GitHub Pages)
 * รับ POST body เป็น JSON: { "fn": "ชื่อฟังก์ชัน", "args": [...] }
 * ตอบกลับ: { ok: true, data: ... } หรือ { ok: false, error: "ข้อความ" }
 * เรียกได้เฉพาะฟังก์ชันในรายการ API_FUNCTIONS เท่านั้น
 * --------------------------------------------------------------------- */
const API_FUNCTIONS = {
  login: login, logout: logout, getCurrentUser: getCurrentUser,
  changePassword: changePassword, updateProfile: updateProfile,
  getSystemData: getSystemData, getAvailability: getAvailability,
  submitBooking: submitBooking, cancelRequest: cancelRequest, changeSchedule: changeSchedule,
  requestChange: requestChange, closeChangeRequest: closeChangeRequest,
  getAssignOptions: getAssignOptions, assignCarAndDriver: assignCarAndDriver,
  fleetRejectRequest: fleetRejectRequest, endorseRequest: endorseRequest,
  approveRequest: approveRequest, rejectRequest: rejectRequest,
  acknowledgeMission: acknowledgeMission, startMission: startMission, finishMission: finishMission,
  saveVehicle: saveVehicle, saveDriver: saveDriver, saveUser: saveUser,
  resetUserPassword: resetUserPassword, getLogs: getLogs,
  getMySignature: getMySignature, saveMySignature: saveMySignature,
  deleteMySignature: deleteMySignature, getSignatures: getSignatures
};

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(body.fn || '');
    if (!Object.prototype.hasOwnProperty.call(API_FUNCTIONS, fn)) throw new Error('ไม่พบคำสั่งที่เรียกใช้');
    const args = Array.isArray(body.args) ? body.args : [];
    const data = API_FUNCTIONS[fn].apply(null, args);
    return json_({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =====================================================================
 * 2. ติดตั้งระบบ (รันครั้งแรก หรือรันซ้ำเมื่ออัปเดตเวอร์ชัน ข้อมูลเดิมไม่หาย)
 * ===================================================================== */

function setupSystem() {
  SETUP_RUNNING_ = true;
  const book = ss_();
  Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(book, name, SCHEMA[name]); });

  const msg = [];
  sigFolder_(); folder_('CAR_PHOTO_FOLDER_ID'); folder_('RETURN_PHOTO_FOLDER_ID'); // เตรียมโฟลเดอร์
  msg.push('สเปรดชีต: ' + book.getUrl());
  if (readAll_('Drivers').length === 0) {
    appendObj_('Drivers', { "รหัสพนักงาน": "D01", "ชื่อ-นามสกุล": "นายสมศักดิ์ ขับดี", "เบอร์โทร": "089-111-2222", "ประเภทใบอนุญาต": "ท.2", "วันหมดอายุใบอนุญาต": "2028-12-31", "สถานะ": "พร้อมปฏิบัติงาน" });
    appendObj_('Drivers', { "รหัสพนักงาน": "D02", "ชื่อ-นามสกุล": "นายสมชาย ปลอดภัย", "เบอร์โทร": "081-333-4444", "ประเภทใบอนุญาต": "ท.2", "วันหมดอายุใบอนุญาต": "2027-05-15", "สถานะ": "พร้อมปฏิบัติงาน" });
    msg.push('เพิ่มพนักงานขับรถตัวอย่าง');
  }
  if (readAll_('Vehicles').length === 0) {
    appendObj_('Vehicles', { "รหัสรถ": "V01", "ทะเบียนรถ": "นข 1234 นครศรีธรรมราช", "ยี่ห้อ/รุ่น": "Toyota Commuter", "ประเภทรถ": "รถตู้", "จำนวนที่นั่ง": 12, "สถานะ": "พร้อมใช้งาน", "เลขไมล์ล่าสุด": 0 });
    appendObj_('Vehicles', { "รหัสรถ": "V02", "ทะเบียนรถ": "บก 5678 นครศรีธรรมราช", "ยี่ห้อ/รุ่น": "Isuzu D-Max", "ประเภทรถ": "รถกระบะ 4 ประตู", "จำนวนที่นั่ง": 5, "สถานะ": "พร้อมใช้งาน", "เลขไมล์ล่าสุด": 0 });
    msg.push('เพิ่มรถตัวอย่าง');
  }
  if (readAll_('Users').length === 0) {
    const drivers = readAll_('Drivers');
    const d1 = drivers[0] || {};
    createUserRow_({ username: 'admin', name: 'ผู้ดูแลระบบ', position: 'นักวิชาการคอมพิวเตอร์', department: 'กลุ่มส่งเสริมการศึกษาทางไกลฯ', role: 'admin' }, DEFAULT_PASSWORD);
    createUserRow_({ username: 'director', name: 'ผู้อำนวยการ', position: 'ผู้อำนวยการสำนักงานเขตพื้นที่การศึกษา', department: 'ผู้บริหาร', role: 'director' }, DEFAULT_PASSWORD);
    createUserRow_({ username: 'driver01', name: d1["ชื่อ-นามสกุล"] || 'พนักงานขับรถ', position: 'พนักงานขับรถยนต์', department: 'กลุ่มอำนวยการ', phone: d1["เบอร์โทร"] || '', role: 'driver', driverId: d1["รหัสพนักงาน"] || '' }, DEFAULT_PASSWORD);
    createUserRow_({ username: 'user01', name: 'ครูสมชาย ใจดี', position: 'ครูชำนาญการ', department: 'กลุ่มสาระการเรียนรู้คณิตศาสตร์', phone: '081-234-5678', role: 'user' }, DEFAULT_PASSWORD);
    msg.push('สร้างบัญชีผู้ใช้ตัวอย่าง admin, director, driver01, user01 รหัสผ่านเริ่มต้น ' + DEFAULT_PASSWORD);
  }
  const users = readAll_('Users');
  const hasRole = function (role) { return users.some(function (x) { return x["บทบาท"] === role; }); };
  if (!hasRole('fleet') && !findUserRow_('fleet01')) {
    createUserRow_({ username: 'fleet01', name: 'หัวหน้างานยานพาหนะ', position: 'หัวหน้างานยานพาหนะ', department: 'กลุ่มอำนวยการ', role: 'fleet' }, DEFAULT_PASSWORD);
    msg.push('สร้างบัญชี fleet01 (หัวหน้างานยานพาหนะ)');
  }
  if (!hasRole('supervisor') && !findUserRow_('head01')) {
    createUserRow_({ username: 'head01', name: 'ผู้อำนวยการกลุ่มอำนวยการ', position: 'ผู้อำนวยการกลุ่มอำนวยการ', department: 'กลุ่มอำนวยการ', role: 'supervisor' }, DEFAULT_PASSWORD);
    msg.push('สร้างบัญชี head01 (เจ้าหน้าที่ / ผู้อำนวยการกลุ่ม)');
  }
  if (!hasRole('clerk') && !findUserRow_('clerk01')) {
    createUserRow_({ username: 'clerk01', name: 'เจ้าหน้าที่ธุรการ', position: 'เจ้าพนักงานธุรการ', department: 'กลุ่มอำนวยการ', role: 'clerk' }, DEFAULT_PASSWORD);
    msg.push('สร้างบัญชี clerk01 (เจ้าหน้าที่ธุรการ)');
  }
  // แปลงสถานะคำขอจากเวอร์ชันก่อน ให้เข้าสู่ลำดับขั้นตอนใหม่
  let migrated = 0;
  readAll_('Requests').forEach(function (r) {
    const to = LEGACY_STATUS[r["สถานะ"]];
    if (!to) return;
    const patch = { "สถานะ": to, "หมายเหตุ": appendNote_(r["หมายเหตุ"], 'ปรับเข้าสู่ขั้นตอนใหม่ (สถานะเดิม: ' + r["สถานะ"] + ')') };
    if (to === ST.WAIT_FLEET) { patch["รถยนต์ที่จัดสรร"] = '-'; patch["พนักงานขับรถ"] = '-'; patch["รหัสรถ"] = ''; patch["รหัสพนักงานขับรถ"] = ''; }
    updateObj_('Requests', r._row, patch);
    migrated++;
  });
  if (migrated) msg.push('ปรับสถานะคำขอเดิมเข้าสู่ขั้นตอนใหม่ ' + migrated + ' รายการ');
  const result = 'ตั้งค่าระบบเรียบร้อยแล้ว' + (msg.length ? ' : ' + msg.join(' / ') : '');
  Logger.log(result);
  return result;
}

// คงชื่อฟังก์ชันเดิมไว้เพื่อความเข้ากันได้
function initDatabase() { return setupSystem(); }

/* =====================================================================
 * 3. ระบบเข้าสู่ระบบและเซสชัน
 * ===================================================================== */

function login(username, password) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (!username || !password) throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');

  const cache = CacheService.getScriptCache();
  const failKey = 'F_' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_LOGIN_ATTEMPTS) {
    throw new Error('บัญชีนี้ถูกระงับชั่วคราว เนื่องจากกรอกรหัสผ่านผิดเกิน ' + MAX_LOGIN_ATTEMPTS + ' ครั้ง กรุณารอ 15 นาทีแล้วลองใหม่');
  }

  const row = findUserRow_(username);
  if (!row || hash_(password, row["Salt"]) !== String(row["รหัสผ่าน(เข้ารหัส)"])) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  if (row["สถานะ"] !== 'ใช้งาน') throw new Error('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');

  cache.remove(failKey);
  updateObj_('Users', row._row, { "เข้าสู่ระบบล่าสุด": now_() });
  const user = publicUser_(row);
  const token = createSession_(user);
  log_(user, 'เข้าสู่ระบบ', '');
  return { token: token, user: user, org: ORG_NAME, form: FORM3 };
}

function logout(token) {
  try {
    const u = auth_(token, null, true);
    log_(u, 'ออกจากระบบ', '');
  } catch (e) { /* เซสชันหมดอายุแล้ว */ }
  if (token) CacheService.getScriptCache().remove('S_' + token);
  return true;
}

// ใช้ตรวจสอบเซสชันเดิมเมื่อเปิดหน้าเว็บใหม่
function getCurrentUser(token) {
  try {
    const u = auth_(token, null, true);
    return { user: u, org: ORG_NAME, form: FORM3 };
  } catch (e) {
    return null;
  }
}

function changePassword(token, oldPassword, newPassword) {
  const u = auth_(token, null, true);
  const row = findUserRow_(u.username);
  if (!row) throw new Error('ไม่พบบัญชีผู้ใช้');
  if (hash_(String(oldPassword || ''), row["Salt"]) !== String(row["รหัสผ่าน(เข้ารหัส)"])) {
    throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }
  validatePassword_(newPassword);
  if (newPassword === oldPassword) throw new Error('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม');

  const salt = Utilities.getUuid();
  updateObj_('Users', row._row, {
    "รหัสผ่าน(เข้ารหัส)": hash_(newPassword, salt),
    "Salt": salt,
    "ต้องเปลี่ยนรหัสผ่าน": false
  });
  u.mustChange = false;
  saveSession_(token, u);
  log_(u, 'เปลี่ยนรหัสผ่าน', '');
  return u;
}

function updateProfile(token, data) {
  const u = auth_(token);
  const row = findUserRow_(u.username);
  if (!row) throw new Error('ไม่พบบัญชีผู้ใช้');
  data = data || {};
  const patch = {
    "ตำแหน่ง": clean_(data.position, 100),
    "กลุ่มงาน": clean_(data.department, 100),
    "เบอร์โทร": clean_(data.phone, 30),
    "อีเมล": clean_(data.email, 100)
  };
  updateObj_('Users', row._row, patch);
  u.position = patch["ตำแหน่ง"];
  u.department = patch["กลุ่มงาน"];
  u.phone = patch["เบอร์โทร"];
  u.email = patch["อีเมล"];
  saveSession_(token, u);
  log_(u, 'แก้ไขข้อมูลส่วนตัว', '');
  return u;
}

/* =====================================================================
 * 4. ดึงข้อมูลตามสิทธิ์
 * ===================================================================== */

function getSystemData(token) {
  const u = auth_(token);
  const all = readAll_('Requests').map(stripRow_);

  let requests;
  if (STAFF_ROLES.indexOf(u.role) >= 0) requests = all;
  else if (u.role === 'driver') requests = all.filter(function (r) { return isDriverOf_(r, u); });
  else requests = all.filter(function (r) { return isOwner_(r, u); });

  // ปฏิทินกลาง: ทุกบทบาทเห็นการใช้รถ เพื่อตรวจสอบรถว่างก่อนขอ (แสดงเฉพาะข้อมูลที่จำเป็น)
  const calendar = all
    .filter(function (r) { return r["สถานะ"] !== ST.CANCELLED && r["สถานะ"] !== ST.REJECTED; })
    .map(function (r) {
      return {
        id: r["เลขที่คำขอ"], dateStart: r["วันที่เดินทาง"], timeStart: r["เวลาเดินทาง"],
        dateEnd: r["วันที่กลับ"], timeEnd: r["เวลากลับ"], car: r["รถยนต์ที่จัดสรร"], carId: r["รหัสรถ"],
        driver: r["พนักงานขับรถ"], destination: r["สถานที่ปลายทาง"], province: r["จังหวัด"],
        status: r["สถานะ"], department: r["กลุ่มงาน"]
      };
    });

  const data = {
    user: u,
    org: ORG_NAME,
    form: FORM3,
    requests: requests,
    calendar: calendar,
    vehicles: readAll_('Vehicles').map(stripRow_)
  };
  if (['admin', 'fleet', 'director'].indexOf(u.role) >= 0) data.drivers = readAll_('Drivers').map(stripRow_);
  if (u.role === 'admin') data.users = readAll_('Users').map(adminUserView_);
  return data;
}

/* =====================================================================
 * 5. ขั้นตอนงานคำขอใช้รถ 5 ขั้น
 *    1 ผู้ขอตรวจสอบรถว่างและยื่นคำขอ          สถานะ: รอหัวหน้ายานพิจารณา
 *    2 หัวหน้างานยานพาหนะพิจารณาจัดรถและคนขับ  สถานะ: รอเห็นชอบ
 *    3 เจ้าหน้าที่ / ผู้อำนวยการกลุ่มเห็นชอบ      สถานะ: รอผู้อำนวยการอนุมัติ
 *    4 ผู้อำนวยการอนุมัติ                       สถานะ: อนุมัติแล้ว
 *    5 พนักงานขับรถรับทราบ ปฏิบัติงาน และส่งมอบงาน สถานะ: กำลังใช้งาน แล้วเป็น เสร็จสิ้น
 * ===================================================================== */

// ขั้นที่ 1 ตรวจสอบรถว่างตามช่วงเวลา (เรียกจากหน้าตรวจสอบรถว่างและแบบฟอร์มขอใช้รถ)
function getAvailability(token, f) {
  auth_(token);
  f = f || {};
  const start = parseDT_(f.dateStart, f.timeStart || '00:00');
  const end = parseDT_(f.dateEnd || f.dateStart, f.timeEnd || '23:59');
  if (!start || !end || end <= start) throw new Error('กรุณาระบุช่วงวันเวลาให้ถูกต้อง');
  return availability_(start, end, Number(f.passengerCount) || 1, null);
}

// ขั้นที่ 1 ยื่นคำขอ (ทุกบทบาทยกเว้นพนักงานขับรถ) ระบบรับคำขอเฉพาะช่วงเวลาที่ยังมีรถว่าง
function submitBooking(token, f, sign) {
  const u = auth_(token, REQUESTER_ROLES);
  f = f || {};
  const required = { purpose: 'วัตถุประสงค์', destination: 'สถานที่ปลายทาง', province: 'จังหวัด', dateStart: 'วันที่ไป', timeStart: 'เวลาออกเดินทาง', dateEnd: 'วันที่กลับ', timeEnd: 'เวลากลับ' };
  Object.keys(required).forEach(function (k) {
    if (!String(f[k] || '').trim()) throw new Error('กรุณากรอก' + required[k]);
  });
  const fundProject = f.fundSource === 'project';
  if (fundProject && !String(f.projectName || '').trim()) throw new Error('กรุณาระบุชื่อโครงการที่ใช้งบประมาณค่าน้ำมัน');
  const passengers = Number(f.passengerCount);
  if (!(passengers >= 1 && passengers <= 100)) throw new Error('จำนวนผู้โดยสารไม่ถูกต้อง');

  const start = parseDT_(f.dateStart, f.timeStart);
  const end = parseDT_(f.dateEnd, f.timeEnd);
  if (!start || !end) throw new Error('รูปแบบวันที่หรือเวลาไม่ถูกต้อง');
  if (end <= start) throw new Error('วันเวลากลับต้องอยู่หลังวันเวลาออกเดินทาง');
  const todayStart = parseDT_(today_(), '00:00');
  if (start < todayStart && u.role !== 'admin') throw new Error('ไม่สามารถยื่นคำขอย้อนหลังได้ หากจำเป็นกรุณาติดต่องานยานพาหนะ');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const av = availability_(start, end, passengers, null);
    if (!av.canRequest) throw new Error('ไม่สามารถขอใช้รถได้: ' + av.message);
    const reqNo = nextRequestNo_();
    const sig = resolveSignature_(u, sign, 'ผู้ขอ', reqNo, SIGN_REQUIRED.request);
    appendObj_('Requests', {
      "เลขที่คำขอ": reqNo,
      "วันที่ยื่นคำขอ": today_(),
      "ชื่อผู้ขอ": u.name,
      "ตำแหน่ง": clean_(f.position, 100) || u.position,
      "กลุ่มงาน": clean_(f.department, 100) || u.department,
      "เบอร์โทร": clean_(f.phone, 30) || u.phone,
      "วัตถุประสงค์": clean_(f.purpose, 500),
      "สถานที่ปลายทาง": clean_(f.destination, 300),
      "จังหวัด": clean_(f.province, 60),
      "วันที่เดินทาง": f.dateStart,
      "เวลาเดินทาง": f.timeStart,
      "วันที่กลับ": f.dateEnd,
      "เวลากลับ": f.timeEnd,
      "จำนวนผู้โดยสาร": passengers,
      "รายชื่อผู้ร่วมเดินทาง": clean_(f.travelersList, 2000),
      "สถานะ": ST.WAIT_FLEET,
      "รถยนต์ที่จัดสรร": "-",
      "พนักงานขับรถ": "-",
      "ชื่อผู้ใช้ผู้ขอ": u.username,
      "หัวหน้าคณะ": clean_(f.leader, 100) || u.name,
      "แหล่งงบประมาณน้ำมัน": fundProject ? 'โครงการ' : FORM3.fundAgency,
      "ชื่อโครงการ": fundProject ? clean_(f.projectName, 300) : '',
      "แผนปฏิบัติงานประจำปี": clean_(f.planYear, 10) || String(fiscalYearBE_()),
      "ลายเซ็นผู้ขอ": sig ? sig.id : '',
      "วิธีลงนามผู้ขอ": sig ? sig.method : ''
    });
    log_(u, 'ยื่นคำขอใช้รถ', reqNo + ' ' + f.destination);
    return reqNo;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- การยกเลิกและเปลี่ยนวันเวลาเดินทาง (หัวหน้างานยานพาหนะ และเจ้าหน้าที่ธุรการ เท่านั้น) ---------- */
const CHANGEABLE_STATUSES = [ST.WAIT_FLEET, ST.WAIT_ENDORSE, ST.WAIT_APPROVE, ST.APPROVED];

function cancelRequest(token, reqNo, reason) {
  const u = auth_(token, CHANGE_ROLES);
  const r = getReq_(reqNo);
  if (CHANGEABLE_STATUSES.indexOf(r["สถานะ"]) < 0) throw new Error('คำขอสถานะ "' + r["สถานะ"] + '" ไม่สามารถยกเลิกได้');
  if (!String(reason || '').trim()) throw new Error('กรุณาระบุเหตุผลการยกเลิก');
  updateObj_('Requests', r._row, {
    "สถานะ": ST.CANCELLED,
    "ผู้ยกเลิก": u.name + (u.position ? ' (' + u.position + ')' : ''),
    "เหตุผลการยกเลิก": clean_(reason, 300),
    "วันเวลายกเลิก": now_(),
    "คำร้องขอเปลี่ยนแปลง": '', "วันเวลาคำร้อง": '',
    "หมายเหตุ": appendNote_(r["หมายเหตุ"], 'ยกเลิกโดย ' + u.name + ' เหตุผล: ' + clean_(reason, 300))
  });
  log_(u, 'ยกเลิกการใช้รถ', reqNo + ' ' + reason);
  return true;
}

function changeSchedule(token, reqNo, f, reason) {
  const u = auth_(token, CHANGE_ROLES);
  f = f || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const r = getReq_(reqNo);
    if (CHANGEABLE_STATUSES.indexOf(r["สถานะ"]) < 0) throw new Error('เปลี่ยนวันเวลาได้เฉพาะคำขอที่ยังไม่ออกเดินทาง');
    if (!String(reason || '').trim()) throw new Error('กรุณาระบุเหตุผลการเปลี่ยนวันเวลา');
    const start = parseDT_(f.dateStart, f.timeStart), end = parseDT_(f.dateEnd, f.timeEnd);
    if (!start || !end) throw new Error('รูปแบบวันที่หรือเวลาไม่ถูกต้อง');
    if (end <= start) throw new Error('วันเวลากลับต้องอยู่หลังวันเวลาออกเดินทาง');

    const moved = Object.assign({}, r, { "วันที่เดินทาง": f.dateStart, "เวลาเดินทาง": f.timeStart, "วันที่กลับ": f.dateEnd, "เวลากลับ": f.timeEnd });
    if (HOLD_STATUSES.indexOf(r["สถานะ"]) >= 0 && r["รหัสรถ"]) {
      // ตรวจว่ารถและพนักงานขับรถเดิมยังว่างในช่วงเวลาใหม่
      const opt = assignOptions_(moved);
      const v = opt.vehicles.filter(function (x) { return x.id === String(r["รหัสรถ"]); })[0];
      const d = opt.drivers.filter(function (x) { return x.id === String(r["รหัสพนักงานขับรถ"]); })[0];
      if (v && !v.available) throw new Error('รถ ' + v.plate + ' ไม่ว่างในช่วงเวลาใหม่ (' + v.reason + ') กรุณาเปลี่ยนรถก่อน');
      if (d && !d.available) throw new Error(d.name + ' ไม่ว่างในช่วงเวลาใหม่ (' + d.reason + ') กรุณาเปลี่ยนพนักงานขับรถก่อน');
    } else {
      const av = availability_(start, end, Number(r["จำนวนผู้โดยสาร"]) || 1, reqNo);
      if (!av.canRequest) throw new Error('ช่วงเวลาใหม่ไม่มีรถว่าง: ' + av.message);
    }
    const oldText = r["วันที่เดินทาง"] + ' ' + r["เวลาเดินทาง"] + ' ถึง ' + r["วันที่กลับ"] + ' ' + r["เวลากลับ"];
    const newText = f.dateStart + ' ' + f.timeStart + ' ถึง ' + f.dateEnd + ' ' + f.timeEnd;
    const patch = {
      "วันที่เดินทาง": f.dateStart, "เวลาเดินทาง": f.timeStart, "วันที่กลับ": f.dateEnd, "เวลากลับ": f.timeEnd,
      "ประวัติการเปลี่ยนแปลง": appendNote_(r["ประวัติการเปลี่ยนแปลง"], now_() + ' เปลี่ยนจาก ' + oldText + ' เป็น ' + newText + ' โดย ' + u.name + ' เหตุผล: ' + clean_(reason, 200)),
      "คำร้องขอเปลี่ยนแปลง": '', "วันเวลาคำร้อง": ''
    };
    // พนักงานขับรถต้องลงนามรับทราบกำหนดการใหม่
    if (r["สถานะ"] === ST.APPROVED && r["วันเวลารับทราบ"]) {
      patch["ลายเซ็นพนักงานขับรถ"] = ''; patch["วิธีลงนามพนักงานขับรถ"] = ''; patch["วันเวลารับทราบ"] = '';
    }
    updateObj_('Requests', r._row, patch);
    log_(u, 'เปลี่ยนวันเวลาเดินทาง', reqNo + ' ' + newText);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ผู้ขอแจ้งความประสงค์ขอยกเลิกหรือเปลี่ยนเวลา ให้หัวหน้างานยานพาหนะ / เจ้าหน้าที่ธุรการดำเนินการ
function requestChange(token, reqNo, detail) {
  const u = auth_(token, REQUESTER_ROLES);
  const r = getReq_(reqNo);
  if (!isOwner_(r, u)) throw new Error('แจ้งได้เฉพาะคำขอของตนเอง');
  if (CHANGEABLE_STATUSES.indexOf(r["สถานะ"]) < 0) throw new Error('คำขอนี้ไม่สามารถเปลี่ยนแปลงได้แล้ว');
  if (!String(detail || '').trim()) throw new Error('กรุณาระบุรายละเอียดที่ต้องการเปลี่ยนแปลง');
  updateObj_('Requests', r._row, { "คำร้องขอเปลี่ยนแปลง": clean_(detail, 500), "วันเวลาคำร้อง": now_() });
  log_(u, 'แจ้งขอเปลี่ยนแปลง', reqNo + ' ' + detail);
  return true;
}

// ปิดคำร้องโดยไม่เปลี่ยนแปลง พร้อมบันทึกคำตอบ
function closeChangeRequest(token, reqNo, reply) {
  const u = auth_(token, CHANGE_ROLES);
  const r = getReq_(reqNo);
  if (!r["คำร้องขอเปลี่ยนแปลง"]) throw new Error('คำขอนี้ไม่มีคำร้องค้างอยู่');
  updateObj_('Requests', r._row, {
    "คำร้องขอเปลี่ยนแปลง": '', "วันเวลาคำร้อง": '',
    "หมายเหตุ": appendNote_(r["หมายเหตุ"], 'ตอบคำร้องโดย ' + u.name + ': ' + (clean_(reply, 300) || 'รับทราบ'))
  });
  log_(u, 'ปิดคำร้อง', reqNo);
  return true;
}

// ขั้นที่ 2 หัวหน้างานยานพาหนะ: ดูรถและพนักงานขับรถที่ว่างในช่วงเวลาของคำขอ
function getAssignOptions(token, reqNo) {
  auth_(token, FLEET_ROLES);
  return assignOptions_(getReq_(reqNo));
}

// ขั้นที่ 2 หัวหน้างานยานพาหนะ: พิจารณาจัดรถและพนักงานขับรถ แล้วส่งต่อให้ผู้เห็นชอบ
function assignCarAndDriver(token, reqNo, vehicleId, driverId, sign, extra) {
  extra = extra || {};
  const u = auth_(token, FLEET_ROLES);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const r = getReq_(reqNo);
    if ([ST.WAIT_FLEET, ST.WAIT_ENDORSE, ST.WAIT_APPROVE, ST.APPROVED].indexOf(r["สถานะ"]) < 0) {
      throw new Error('จัดรถได้เฉพาะคำขอที่ยังไม่ออกเดินทาง');
    }
    const opt = assignOptions_(r);
    const v = opt.vehicles.filter(function (x) { return x.id === vehicleId; })[0];
    const d = opt.drivers.filter(function (x) { return x.id === driverId; })[0];
    if (!v) throw new Error('ไม่พบรถที่เลือก');
    if (!d) throw new Error('ไม่พบพนักงานขับรถที่เลือก');
    if (!v.available) throw new Error('รถ ' + v.plate + ' ไม่ว่าง: ' + v.reason);
    if (!d.available) throw new Error(d.name + ' ไม่ว่าง: ' + d.reason);
    if (Number(v.seats) && Number(r["จำนวนผู้โดยสาร"]) > Number(v.seats)) {
      throw new Error('จำนวนผู้โดยสาร (' + r["จำนวนผู้โดยสาร"] + ' คน) เกินจำนวนที่นั่งของรถ (' + v.seats + ' ที่นั่ง)');
    }
    const sig = resolveSignature_(u, sign, 'ผู้จัดสรรรถ', reqNo, SIGN_REQUIRED.assign);
    const patch = sig ? { "ลายเซ็นผู้จัดสรรรถ": sig.id, "วิธีลงนามผู้จัดสรรรถ": sig.method } : {};
    // เปลี่ยนพนักงานขับรถ ต้องลงนามรับทราบใหม่
    if (r["รหัสพนักงานขับรถ"] && String(r["รหัสพนักงานขับรถ"]) !== d.id) {
      patch["ลายเซ็นพนักงานขับรถ"] = ''; patch["วิธีลงนามพนักงานขับรถ"] = ''; patch["วันเวลารับทราบ"] = '';
    }
    const amount = Number(extra.fuelAmount);
    const firstTime = r["สถานะ"] === ST.WAIT_FLEET;
    updateObj_('Requests', r._row, Object.assign(patch, {
      "รหัสรถ": v.id,
      "รถยนต์ที่จัดสรร": v.plate,
      "รหัสพนักงานขับรถ": d.id,
      "พนักงานขับรถ": d.name,
      "สถานะ": firstTime ? ST.WAIT_ENDORSE : r["สถานะ"],
      "ผู้จัดสรรรถ": u.name,
      "ตำแหน่งผู้จัดสรรรถ": u.position,
      "วันเวลาจัดสรร": now_(),
      "ความเห็นผู้จัดสรรรถ": clean_(extra.comment, 300),
      "ชนิดน้ำมันที่อนุญาต": FUEL_TYPES.indexOf(extra.fuelType) >= 0 ? extra.fuelType : '',
      "วงเงินน้ำมัน": amount > 0 ? Math.round(amount * 100) / 100 : '',
      "ใบสั่งซื้อเล่มที่": clean_(extra.poBook, 20),
      "ใบสั่งซื้อเลขที่": clean_(extra.poNo, 20)
    }));
    log_(u, firstTime ? 'จัดรถและพนักงานขับรถ' : 'เปลี่ยนการจัดรถ', reqNo + ' ' + v.plate + ' / ' + d.name);
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ขั้นที่ 2 หัวหน้างานยานพาหนะ: ไม่สามารถจัดรถได้ (ต้องระบุเหตุผล)
function fleetRejectRequest(token, reqNo, reason) {
  const u = auth_(token, FLEET_ROLES);
  const r = getReq_(reqNo);
  if (r["สถานะ"] !== ST.WAIT_FLEET) throw new Error('คำขอนี้ไม่อยู่ในขั้นตอนหัวหน้ายานพิจารณา');
  if (!String(reason || '').trim()) throw new Error('กรุณาระบุเหตุผลที่ไม่สามารถจัดรถได้');
  updateObj_('Requests', r._row, {
    "สถานะ": ST.REJECTED,
    "ขั้นตอนที่ไม่ผ่าน": 'หัวหน้างานยานพาหนะ',
    "ผู้จัดสรรรถ": u.name,
    "ตำแหน่งผู้จัดสรรรถ": u.position,
    "วันเวลาจัดสรร": now_(),
    "ความเห็นผู้จัดสรรรถ": clean_(reason, 300)
  });
  log_(u, 'ไม่สามารถจัดรถได้', reqNo + ' ' + reason);
  return true;
}

// ขั้นที่ 3 เจ้าหน้าที่ / ผู้อำนวยการกลุ่ม: เห็นชอบ หรือไม่เห็นชอบ
function endorseRequest(token, reqNo, agree, comment, sign) {
  const u = auth_(token, ['supervisor']);
  const r = getReq_(reqNo);
  if (r["สถานะ"] !== ST.WAIT_ENDORSE) throw new Error('คำขอนี้ไม่อยู่ในขั้นตอนรอเห็นชอบ (สถานะปัจจุบัน: ' + r["สถานะ"] + ')');
  if (!agree && !String(comment || '').trim()) throw new Error('กรุณาระบุเหตุผลที่ไม่เห็นชอบ');
  const sig = resolveSignature_(u, sign, 'ผู้เห็นชอบ', reqNo, SIGN_REQUIRED.endorse);
  const patch = {
    "ผู้เห็นชอบ": u.name,
    "ตำแหน่งผู้เห็นชอบ": u.position,
    "วันเวลาเห็นชอบ": now_(),
    "ความเห็นผู้เห็นชอบ": clean_(comment, 500) || (agree ? 'เห็นชอบ' : ''),
    "ลายเซ็นผู้เห็นชอบ": sig ? sig.id : '',
    "วิธีลงนามผู้เห็นชอบ": sig ? sig.method : '',
    "สถานะ": agree ? ST.WAIT_APPROVE : ST.REJECTED
  };
  if (!agree) patch["ขั้นตอนที่ไม่ผ่าน"] = 'ผู้เห็นชอบ';
  updateObj_('Requests', r._row, patch);
  log_(u, agree ? 'เห็นชอบคำขอ' : 'ไม่เห็นชอบคำขอ', reqNo);
  return true;
}

// ขั้นที่ 4 ผู้อำนวยการอนุมัติ
function approveRequest(token, reqNo, comment, sign, order) {
  const u = auth_(token, ['director']);
  const r = getReq_(reqNo);
  if (r["สถานะ"] !== ST.WAIT_APPROVE) throw new Error('คำขอนี้ไม่อยู่ในขั้นตอนรอผู้อำนวยการอนุมัติ (สถานะปัจจุบัน: ' + r["สถานะ"] + ')');
  const sig = resolveSignature_(u, sign, 'ผู้อนุมัติ', reqNo, SIGN_REQUIRED.approve);
  updateObj_('Requests', r._row, {
    "ลายเซ็นผู้อนุมัติ": sig ? sig.id : '',
    "วิธีลงนามผู้อนุมัติ": sig ? sig.method : '',
    "ชื่อผู้อนุมัติ": u.name,
    "ตำแหน่งผู้อนุมัติ": u.position,
    "คำสั่งผู้อนุมัติ": ORDER_TYPES.indexOf(order) >= 0 ? order : ORDER_TYPES[0],
    "สถานะ": ST.APPROVED,
    "ผู้อนุมัติ": u.name + (u.position ? ' (' + u.position + ')' : ''),
    "วันเวลาอนุมัติ": now_(),
    "ความเห็นผู้อนุมัติ": clean_(comment, 500) || 'อนุมัติ'
  });
  log_(u, 'อนุมัติคำขอ', reqNo);
  return true;
}

// ขั้นที่ 4 ผู้อำนวยการไม่อนุมัติ (ต้องระบุเหตุผล)
function rejectRequest(token, reqNo, comment, sign) {
  const u = auth_(token, ['director']);
  const r = getReq_(reqNo);
  if (r["สถานะ"] !== ST.WAIT_APPROVE) throw new Error('คำขอนี้ไม่อยู่ในขั้นตอนรอผู้อำนวยการอนุมัติ');
  if (!String(comment || '').trim()) throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
  const sig = resolveSignature_(u, sign, 'ผู้อนุมัติ', reqNo, SIGN_REQUIRED.approve);
  updateObj_('Requests', r._row, {
    "ลายเซ็นผู้อนุมัติ": sig ? sig.id : '',
    "วิธีลงนามผู้อนุมัติ": sig ? sig.method : '',
    "ชื่อผู้อนุมัติ": u.name,
    "ตำแหน่งผู้อนุมัติ": u.position,
    "คำสั่งผู้อนุมัติ": 'ไม่อนุญาต',
    "สถานะ": ST.REJECTED,
    "ขั้นตอนที่ไม่ผ่าน": 'ผู้อำนวยการ',
    "ผู้อนุมัติ": u.name + (u.position ? ' (' + u.position + ')' : ''),
    "วันเวลาอนุมัติ": now_(),
    "ความเห็นผู้อนุมัติ": clean_(comment, 500)
  });
  log_(u, 'ไม่อนุมัติคำขอ', reqNo + ' ' + comment);
  return true;
}

// พนักงานขับรถ: ลงนามรับทราบการมอบหมาย (ช่อง "รับทราบ" ในแบบ ๓)
function acknowledgeMission(token, reqNo, sign) {
  const u = auth_(token, ['driver']);
  const r = getReq_(reqNo);
  if (!isDriverOf_(r, u)) throw new Error('คำขอนี้ไม่ได้มอบหมายให้ท่าน');
  if (r["สถานะ"] !== ST.APPROVED) throw new Error('ลงนามรับทราบได้เฉพาะคำขอที่จัดสรรรถแล้วและยังไม่ออกเดินทาง');
  if (r["วันเวลารับทราบ"]) throw new Error('ท่านลงนามรับทราบภารกิจนี้แล้ว');
  const sig = resolveSignature_(u, sign, 'พนักงานขับรถ', reqNo, SIGN_REQUIRED.acknowledge);
  updateObj_('Requests', r._row, {
    "ลายเซ็นพนักงานขับรถ": sig ? sig.id : '',
    "วิธีลงนามพนักงานขับรถ": sig ? sig.method : '',
    "วันเวลารับทราบ": now_()
  });
  log_(u, 'ลงนามรับทราบภารกิจ', reqNo);
  return true;
}

// พนักงานขับรถ: บันทึกก่อนออกเดินทาง
function startMission(token, reqNo, startMileage, startFuel, base64Image) {
  const u = auth_(token, ['driver', 'fleet', 'admin']);
  const r = getReq_(reqNo);
  if (u.role === 'driver' && !isDriverOf_(r, u)) throw new Error('คำขอนี้ไม่ได้มอบหมายให้ท่าน');
  if (r["สถานะ"] !== ST.APPROVED) throw new Error('บันทึกออกเดินทางได้เฉพาะคำขอที่จัดสรรรถแล้ว');
  if (u.role === 'driver' && !r["วันเวลารับทราบ"]) throw new Error('กรุณาลงนามรับทราบภารกิจก่อนบันทึกออกเดินทาง');

  const mileage = Number(startMileage);
  if (!(mileage >= 0)) throw new Error('กรุณาระบุเลขไมล์ก่อนเดินทางให้ถูกต้อง');
  const veh = findVehicle_(r);
  if (veh && Number(veh["เลขไมล์ล่าสุด"]) > 0 && mileage < Number(veh["เลขไมล์ล่าสุด"])) {
    throw new Error('เลขไมล์ที่ระบุ (' + mileage + ') น้อยกว่าเลขไมล์ล่าสุดของรถ (' + veh["เลขไมล์ล่าสุด"] + ')');
  }

  let imageUrl = '';
  if (base64Image) imageUrl = uploadImageToDrive_(base64Image, 'Start_' + reqNo + '_' + Date.now() + '.jpg', 'CAR_PHOTO_FOLDER_ID');

  const patch = {
    "เลขไมล์ก่อนเดินทาง": mileage,
    "ระดับน้ำมันก่อนเดินทาง": clean_(startFuel, 30),
    "สถานะ": ST.ACTIVE,
    "วันเวลาออกเดินทางจริง": now_()
  };
  if (imageUrl) patch["รูปภาพก่อนเดินทาง"] = imageUrl;
  updateObj_('Requests', r._row, patch);

  if (veh) updateObj_('Vehicles', veh._row, { "สถานะ": "อยู่ระหว่างใช้งาน" });
  const drv = findDriver_(r);
  if (drv) updateObj_('Drivers', drv._row, { "สถานะ": "กำลังปฏิบัติงาน" });

  log_(u, 'บันทึกออกเดินทาง', reqNo + ' เลขไมล์ ' + mileage);
  return true;
}

// พนักงานขับรถ: บันทึกหลังเดินทางกลับ
function finishMission(token, reqNo, data, base64Image, sign) {
  const u = auth_(token, ['driver', 'fleet', 'admin']);
  const r = getReq_(reqNo);
  if (u.role === 'driver' && !isDriverOf_(r, u)) throw new Error('คำขอนี้ไม่ได้มอบหมายให้ท่าน');
  if (r["สถานะ"] !== ST.ACTIVE) throw new Error('บันทึกส่งมอบงานได้เฉพาะคำขอที่อยู่ระหว่างใช้งาน');
  data = data || {};
  if (!data.handover) throw new Error('กรุณายืนยันการส่งคืนกุญแจรถและเอกสารประจำรถ');

  const endMileage = Number(data.endMileage);
  const startMileage = Number(r["เลขไมล์ก่อนเดินทาง"]) || 0;
  if (!(endMileage >= 0)) throw new Error('กรุณาระบุเลขไมล์หลังเดินทางให้ถูกต้อง');
  if (endMileage < startMileage) throw new Error('เลขไมล์หลังเดินทางต้องไม่น้อยกว่าเลขไมล์ก่อนเดินทาง (' + startMileage + ')');
  const condition = VEHICLE_CONDITIONS.indexOf(data.vehicleCondition) >= 0 ? data.vehicleCondition : '';
  const result = TRIP_RESULTS.indexOf(data.tripResult) >= 0 ? data.tripResult : '';
  if (!condition) throw new Error('กรุณาเลือกสภาพรถหลังใช้งาน');
  if (!result) throw new Error('กรุณาเลือกผลการปฏิบัติงาน');
  if ((condition !== 'ปกติ' || result !== 'เรียบร้อยตามกำหนด') && !String(data.note || '').trim()) {
    throw new Error('กรุณาระบุรายละเอียดความชำรุดหรือเหตุขัดข้องในช่องหมายเหตุ');
  }
  const sig = resolveSignature_(u, sign, 'ส่งมอบงาน', reqNo, SIGN_REQUIRED.handover && u.role === 'driver');
  const money = function (x) { const n = Number(x); if (!(n >= 0)) return 0; return Math.round(n * 100) / 100; };

  let imageUrl = '';
  if (base64Image) imageUrl = uploadImageToDrive_(base64Image, 'End_' + reqNo + '_' + Date.now() + '.jpg', 'RETURN_PHOTO_FOLDER_ID');

  const patch = {
    "เลขไมล์หลังเดินทาง": endMileage,
    "ระยะทางรวม": endMileage - startMileage,
    "ระดับน้ำมันหลังเดินทาง": clean_(data.endFuel, 30),
    "ค่าน้ำมัน": money(data.fuelExpense),
    "ค่าทางด่วน": money(data.tollExpense),
    "ค่าใช้จ่ายอื่น": money(data.otherExpense),
    "สถานะ": ST.DONE,
    "วันเวลากลับถึงจริง": now_(),
    "ส่งคืนกุญแจและเอกสาร": 'ส่งคืนแล้ว',
    "สภาพรถหลังใช้งาน": condition,
    "ผลการปฏิบัติงาน": result,
    "ลายเซ็นส่งมอบงาน": sig ? sig.id : '',
    "วิธีลงนามส่งมอบงาน": sig ? sig.method : ''
  };
  if (data.note) patch["หมายเหตุ"] = appendNote_(r["หมายเหตุ"], 'พนักงานขับรถ: ' + clean_(data.note, 300));
  if (imageUrl) patch["รูปภาพหลังใช้งาน"] = imageUrl;
  updateObj_('Requests', r._row, patch);

  const veh = findVehicle_(r);
  if (veh) {
    const vp = { "เลขไมล์ล่าสุด": endMileage };
    if (condition === 'ต้องซ่อมบำรุง') {
      vp["สถานะ"] = 'ซ่อมบำรุง';
      vp["หมายเหตุ"] = appendNote_(veh["หมายเหตุ"], today_() + ' แจ้งซ่อมจาก ' + reqNo + ': ' + clean_(data.note, 200));
    } else if (veh["สถานะ"] === 'อยู่ระหว่างใช้งาน') vp["สถานะ"] = 'พร้อมใช้งาน';
    updateObj_('Vehicles', veh._row, vp);
  }
  const drv = findDriver_(r);
  if (drv && drv["สถานะ"] === 'กำลังปฏิบัติงาน') updateObj_('Drivers', drv._row, { "สถานะ": "พร้อมปฏิบัติงาน" });

  log_(u, 'ส่งมอบงาน', reqNo + ' ระยะทาง ' + (endMileage - startMileage) + ' กม.');
  return true;
}

/* =====================================================================
 * 6. งานผู้ดูแลระบบ: รถ พนักงานขับรถ ผู้ใช้ ประวัติการใช้งาน
 * ===================================================================== */

function saveVehicle(token, v) {
  const u = auth_(token, FLEET_ROLES);
  v = v || {};
  const plate = clean_(v.plate, 60);
  if (!plate) throw new Error('กรุณาระบุทะเบียนรถ');
  const status = VEHICLE_STATUS.indexOf(v.status) >= 0 ? v.status : 'พร้อมใช้งาน';
  const list = readAll_('Vehicles');
  const dup = list.filter(function (x) { return String(x["ทะเบียนรถ"]).trim() === plate && String(x["รหัสรถ"]) !== String(v.id || ''); });
  if (dup.length) throw new Error('ทะเบียนรถนี้มีอยู่ในระบบแล้ว');

  const obj = {
    "ทะเบียนรถ": plate,
    "ยี่ห้อ/รุ่น": clean_(v.model, 100),
    "ประเภทรถ": clean_(v.type, 60),
    "จำนวนที่นั่ง": Number(v.seats) || 0,
    "สถานะ": status,
    "เลขไมล์ล่าสุด": Number(v.mileage) || 0,
    "หมายเหตุ": clean_(v.note, 300),
    "ชนิดเชื้อเพลิง": FUEL_TYPES.indexOf(v.fuel) >= 0 ? v.fuel : ''
  };
  if (v.id) {
    const row = list.filter(function (x) { return String(x["รหัสรถ"]) === String(v.id); })[0];
    if (!row) throw new Error('ไม่พบข้อมูลรถ');
    updateObj_('Vehicles', row._row, obj);
    log_(u, 'แก้ไขข้อมูลรถ', v.id + ' ' + plate);
    return v.id;
  }
  obj["รหัสรถ"] = nextCode_(list, "รหัสรถ", 'V');
  appendObj_('Vehicles', obj);
  log_(u, 'เพิ่มรถ', obj["รหัสรถ"] + ' ' + plate);
  return obj["รหัสรถ"];
}

function saveDriver(token, d) {
  const u = auth_(token, FLEET_ROLES);
  d = d || {};
  const name = clean_(d.name, 100);
  if (!name) throw new Error('กรุณาระบุชื่อ-นามสกุล');
  const list = readAll_('Drivers');
  const obj = {
    "ชื่อ-นามสกุล": name,
    "เบอร์โทร": clean_(d.phone, 30),
    "ประเภทใบอนุญาต": clean_(d.license, 30),
    "วันหมดอายุใบอนุญาต": clean_(d.expiry, 10),
    "สถานะ": DRIVER_STATUS.indexOf(d.status) >= 0 ? d.status : 'พร้อมปฏิบัติงาน'
  };
  if (d.id) {
    const row = list.filter(function (x) { return String(x["รหัสพนักงาน"]) === String(d.id); })[0];
    if (!row) throw new Error('ไม่พบข้อมูลพนักงานขับรถ');
    updateObj_('Drivers', row._row, obj);
    log_(u, 'แก้ไขข้อมูลพนักงานขับรถ', d.id + ' ' + name);
    return d.id;
  }
  obj["รหัสพนักงาน"] = nextCode_(list, "รหัสพนักงาน", 'D');
  appendObj_('Drivers', obj);
  log_(u, 'เพิ่มพนักงานขับรถ', obj["รหัสพนักงาน"] + ' ' + name);
  return obj["รหัสพนักงาน"];
}

// เพิ่มหรือแก้ไขบัญชีผู้ใช้ คืนค่ารหัสผ่านชั่วคราวเมื่อสร้างบัญชีใหม่
function saveUser(token, d) {
  const admin = auth_(token, ['admin']);
  d = d || {};
  const username = String(d.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษตัวเล็ก ตัวเลข หรือ . _ - ความยาว 3 ถึง 30 ตัวอักษร');
  }
  if (!ROLE_LABELS[d.role]) throw new Error('กรุณาเลือกบทบาท');
  if (!clean_(d.name, 100)) throw new Error('กรุณาระบุชื่อ-นามสกุล');
  if (d.role === 'driver' && !d.driverId) throw new Error('บัญชีพนักงานขับรถต้องเชื่อมโยงกับรหัสพนักงานขับรถ');

  const existing = findUserRow_(username);
  if (d.isNew) {
    if (existing) throw new Error('ชื่อผู้ใช้นี้มีอยู่แล้ว');
    let pw = String(d.password || '');
    if (pw) validatePassword_(pw); else pw = randomPassword_();
    createUserRow_({
      username: username, name: d.name, position: d.position, department: d.department,
      phone: d.phone, email: d.email, role: d.role, driverId: d.role === 'driver' ? d.driverId : ''
    }, pw);
    log_(admin, 'เพิ่มผู้ใช้', username + ' (' + ROLE_LABELS[d.role] + ')');
    return { username: username, tempPassword: pw };
  }

  if (!existing) throw new Error('ไม่พบบัญชีผู้ใช้');
  const status = d.status === 'ระงับ' ? 'ระงับ' : 'ใช้งาน';
  if (username === admin.username && (d.role !== 'admin' || status !== 'ใช้งาน')) {
    throw new Error('ไม่สามารถลดสิทธิ์หรือระงับบัญชีของตนเองได้');
  }
  updateObj_('Users', existing._row, {
    "ชื่อ-นามสกุล": clean_(d.name, 100),
    "ตำแหน่ง": clean_(d.position, 100),
    "กลุ่มงาน": clean_(d.department, 100),
    "เบอร์โทร": clean_(d.phone, 30),
    "อีเมล": clean_(d.email, 100),
    "บทบาท": d.role,
    "รหัสพนักงานขับรถ": d.role === 'driver' ? clean_(d.driverId, 20) : '',
    "สถานะ": status
  });
  killUserSessions_(username); // ให้ผู้ใช้เข้าสู่ระบบใหม่เพื่อรับสิทธิ์ล่าสุด
  log_(admin, 'แก้ไขผู้ใช้', username + ' บทบาท ' + d.role + ' สถานะ ' + status);
  return { username: username };
}

function resetUserPassword(token, username) {
  const admin = auth_(token, ['admin']);
  const row = findUserRow_(username);
  if (!row) throw new Error('ไม่พบบัญชีผู้ใช้');
  const pw = randomPassword_();
  const salt = Utilities.getUuid();
  updateObj_('Users', row._row, { "รหัสผ่าน(เข้ารหัส)": hash_(pw, salt), "Salt": salt, "ต้องเปลี่ยนรหัสผ่าน": true });
  killUserSessions_(row["ชื่อผู้ใช้"]);
  CacheService.getScriptCache().remove('F_' + String(row["ชื่อผู้ใช้"]).toLowerCase());
  log_(admin, 'รีเซ็ตรหัสผ่าน', row["ชื่อผู้ใช้"]);
  return pw;
}

function getLogs(token) {
  auth_(token, ['admin']);
  return readAll_('Logs').map(stripRow_).reverse().slice(0, 1000);
}

/* =====================================================================
 * 6.1 ลายมือชื่อ
 * ===================================================================== */

// ดึงลายเซ็นประจำตัว (ผู้ดูแลระบบดึงของผู้ใช้อื่นได้)
function getMySignature(token, username) {
  const u = auth_(token);
  const target = sigTarget_(u, username);
  const row = findUserRow_(target);
  return sigDataUrl_(row && row["ไฟล์ลายเซ็น"]);
}

// บันทึกลายเซ็นประจำตัว จากไฟล์สแกนหรือการวาด (ผู้ดูแลระบบบันทึกให้ผู้ใช้อื่นได้)
function saveMySignature(token, dataUrl, username) {
  const u = auth_(token);
  const target = sigTarget_(u, username);
  const row = findUserRow_(target);
  if (!row) throw new Error('ไม่พบบัญชีผู้ใช้');
  const id = saveSigImage_(dataUrl, 'ลายเซ็นประจำตัว_' + target + '_' + Date.now() + '.png');
  trashFile_(row["ไฟล์ลายเซ็น"]);
  updateObj_('Users', row._row, { "ไฟล์ลายเซ็น": id });
  if (target === u.username) { u.hasSignature = true; saveSession_(token, u); }
  else killUserSessions_(target);
  log_(u, 'บันทึกลายเซ็นประจำตัว', target);
  return u;
}

function deleteMySignature(token, username) {
  const u = auth_(token);
  const target = sigTarget_(u, username);
  const row = findUserRow_(target);
  if (!row) throw new Error('ไม่พบบัญชีผู้ใช้');
  trashFile_(row["ไฟล์ลายเซ็น"]);
  updateObj_('Users', row._row, { "ไฟล์ลายเซ็น": '' });
  if (target === u.username) { u.hasSignature = false; saveSession_(token, u); }
  else killUserSessions_(target);
  log_(u, 'ลบลายเซ็นประจำตัว', target);
  return u;
}

// ดึงลายมือชื่อทั้งหมดของคำขอ เฉพาะผู้มีสิทธิ์เห็นคำขอนั้น
function getSignatures(token, reqNo) {
  const u = auth_(token);
  const r = getReq_(reqNo);
  const canView = STAFF_ROLES.indexOf(u.role) >= 0 || isOwner_(r, u) || (u.role === 'driver' && isDriverOf_(r, u));
  if (!canView) throw new Error('ท่านไม่มีสิทธิ์ดูคำขอนี้');
  const pack = function (idKey, methodKey) {
    const img = sigDataUrl_(r[idKey]);
    return img ? { img: img, method: r[methodKey] || '' } : null;
  };
  return {
    requester: pack("ลายเซ็นผู้ขอ", "วิธีลงนามผู้ขอ"),
    approver: pack("ลายเซ็นผู้อนุมัติ", "วิธีลงนามผู้อนุมัติ"),
    assigner: pack("ลายเซ็นผู้จัดสรรรถ", "วิธีลงนามผู้จัดสรรรถ"),
    endorser: pack("ลายเซ็นผู้เห็นชอบ", "วิธีลงนามผู้เห็นชอบ"),
    driver: pack("ลายเซ็นพนักงานขับรถ", "วิธีลงนามพนักงานขับรถ"),
    handover: pack("ลายเซ็นส่งมอบงาน", "วิธีลงนามส่งมอบงาน")
  };
}

/* =====================================================================
 * 7. ฟังก์ชันภายใน (ลงท้ายด้วย _ เรียกจากหน้าเว็บไม่ได้)
 * ===================================================================== */

// ---------- เซสชัน ----------
function createSession_(user) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  saveSession_(token, user);
  const cache = CacheService.getScriptCache();
  const key = 'U_' + user.username;
  let list = [];
  try { list = JSON.parse(cache.get(key) || '[]'); } catch (e) { list = []; }
  list.push(token);
  cache.put(key, JSON.stringify(list.slice(-10)), SESSION_SECONDS);
  return token;
}

function saveSession_(token, user) {
  CacheService.getScriptCache().put('S_' + token, JSON.stringify(user), SESSION_SECONDS);
}

function killUserSessions_(username) {
  const cache = CacheService.getScriptCache();
  const key = 'U_' + String(username).toLowerCase();
  let list = [];
  try { list = JSON.parse(cache.get(key) || '[]'); } catch (e) { list = []; }
  if (list.length) cache.removeAll(list.map(function (t) { return 'S_' + t; }));
  cache.remove(key);
}

/**
 * ตรวจสอบเซสชันและสิทธิ์
 * @param {string} token
 * @param {string[]|null} roles บทบาทที่อนุญาต (null = ทุกบทบาท)
 * @param {boolean} allowMustChange อนุญาตแม้ยังไม่ได้เปลี่ยนรหัสผ่านครั้งแรก
 */
function auth_(token, roles, allowMustChange) {
  if (!token) throw new Error('SESSION_EXPIRED: กรุณาเข้าสู่ระบบ');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('S_' + token);
  if (!raw) throw new Error('SESSION_EXPIRED: หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
  cache.put('S_' + token, raw, SESSION_SECONDS); // ต่ออายุเซสชันเมื่อมีการใช้งาน
  const u = JSON.parse(raw);
  if (u.mustChange && !allowMustChange) throw new Error('MUST_CHANGE_PASSWORD: กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน');
  if (roles && roles.indexOf(u.role) < 0) throw new Error('ท่านไม่มีสิทธิ์ดำเนินการนี้ (บทบาท: ' + ROLE_LABELS[u.role] + ')');
  return u;
}

// ---------- ผู้ใช้ ----------
function findUserRow_(username) {
  const key = String(username || '').trim().toLowerCase();
  return readAll_('Users').filter(function (r) { return String(r["ชื่อผู้ใช้"]).trim().toLowerCase() === key; })[0] || null;
}

function createUserRow_(d, password) {
  const salt = Utilities.getUuid();
  appendObj_('Users', {
    "ชื่อผู้ใช้": String(d.username).toLowerCase(),
    "รหัสผ่าน(เข้ารหัส)": hash_(password, salt),
    "Salt": salt,
    "ชื่อ-นามสกุล": clean_(d.name, 100),
    "ตำแหน่ง": clean_(d.position, 100),
    "กลุ่มงาน": clean_(d.department, 100),
    "เบอร์โทร": clean_(d.phone, 30),
    "อีเมล": clean_(d.email, 100),
    "บทบาท": d.role,
    "รหัสพนักงานขับรถ": clean_(d.driverId, 20),
    "สถานะ": 'ใช้งาน',
    "ต้องเปลี่ยนรหัสผ่าน": true,
    "เข้าสู่ระบบล่าสุด": '',
    "วันที่สร้าง": now_()
  });
}

function publicUser_(row) {
  const mc = row["ต้องเปลี่ยนรหัสผ่าน"];
  return {
    username: String(row["ชื่อผู้ใช้"]).toLowerCase(),
    name: String(row["ชื่อ-นามสกุล"] || ''),
    position: String(row["ตำแหน่ง"] || ''),
    department: String(row["กลุ่มงาน"] || ''),
    phone: String(row["เบอร์โทร"] || ''),
    email: String(row["อีเมล"] || ''),
    role: String(row["บทบาท"] || 'user'),
    roleLabel: ROLE_LABELS[row["บทบาท"]] || '',
    driverId: String(row["รหัสพนักงานขับรถ"] || ''),
    mustChange: mc === true || String(mc).toUpperCase() === 'TRUE',
    hasSignature: !!row["ไฟล์ลายเซ็น"]
  };
}

function adminUserView_(row) {
  const p = publicUser_(row);
  p.status = row["สถานะ"];
  p.lastLogin = row["เข้าสู่ระบบล่าสุด"];
  p.created = row["วันที่สร้าง"];
  return p;
}

function hash_(password, salt) {
  let h = String(salt) + '|' + String(password);
  for (let i = 0; i < HASH_ROUNDS; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  return h;
}

function validatePassword_(pw) {
  pw = String(pw || '');
  if (pw.length < 8) throw new Error('รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('รหัสผ่านต้องประกอบด้วยตัวอักษรภาษาอังกฤษและตัวเลข');
}

function randomPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  for (let j = 0; j < 3; j++) s += digits.charAt(Math.floor(Math.random() * digits.length));
  return s;
}

// ---------- คำขอใช้รถ ----------
function getReq_(reqNo) {
  const r = readAll_('Requests').filter(function (x) { return String(x["เลขที่คำขอ"]) === String(reqNo); })[0];
  if (!r) throw new Error('ไม่พบคำขอเลขที่ ' + reqNo);
  return r;
}

function isOwner_(r, u) {
  if (r["ชื่อผู้ใช้ผู้ขอ"]) return String(r["ชื่อผู้ใช้ผู้ขอ"]).toLowerCase() === u.username;
  return norm_(r["ชื่อผู้ขอ"]) === norm_(u.name); // ข้อมูลเดิมก่อนมีระบบล็อกอิน
}

function isDriverOf_(r, u) {
  if (u.driverId && String(r["รหัสพนักงานขับรถ"]) === u.driverId) return true;
  return !r["รหัสพนักงานขับรถ"] && r["พนักงานขับรถ"] && r["พนักงานขับรถ"] !== '-' && norm_(r["พนักงานขับรถ"]) === norm_(u.name);
}

function nextRequestNo_() {
  const be = Number(Utilities.formatDate(new Date(), tz_(), 'yyyy')) + 543;
  const prefix = 'REQ-' + be + '-';
  let max = 0;
  readAll_('Requests').forEach(function (r) {
    const s = String(r["เลขที่คำขอ"]);
    if (s.indexOf(prefix) === 0) max = Math.max(max, Number(s.slice(prefix.length)) || 0);
  });
  return prefix + String(max + 1).padStart(4, '0');
}

function periodOf_(r) {
  return { start: parseDT_(r["วันที่เดินทาง"], r["เวลาเดินทาง"] || '00:00'), end: parseDT_(r["วันที่กลับ"] || r["วันที่เดินทาง"], r["เวลากลับ"] || '23:59') };
}

function overlap_(a, b) {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  return a.start < b.end && b.start < a.end;
}

function assignOptions_(r) {
  const period = periodOf_(r);
  const reqNo = String(r["เลขที่คำขอ"]);
  const busy = readAll_('Requests').filter(function (x) {
    return String(x["เลขที่คำขอ"]) !== reqNo && HOLD_STATUSES.indexOf(x["สถานะ"]) >= 0 && overlap_(periodOf_(x), period);
  });
  const endDate = String(r["วันที่กลับ"] || r["วันที่เดินทาง"]).slice(0, 10);

  const vehicles = readAll_('Vehicles').filter(function (v) { return v["สถานะ"] !== 'เลิกใช้งาน'; }).map(function (v) {
    const id = String(v["รหัสรถ"]);
    const plate = String(v["ทะเบียนรถ"]);
    const clash = busy.filter(function (x) { return String(x["รหัสรถ"]) === id || (!x["รหัสรถ"] && x["รถยนต์ที่จัดสรร"] === plate); });
    let reason = '';
    if (v["สถานะ"] === 'ซ่อมบำรุง') reason = 'อยู่ระหว่างซ่อมบำรุง';
    else if (clash.length) reason = 'มีภารกิจซ้อนเวลา ' + clash.map(function (c) { return c["เลขที่คำขอ"]; }).join(', ');
    return { id: id, plate: plate, model: v["ยี่ห้อ/รุ่น"], type: v["ประเภทรถ"], seats: v["จำนวนที่นั่ง"], status: v["สถานะ"], fuel: v["ชนิดเชื้อเพลิง"] || '', available: !reason, reason: reason };
  });

  const drivers = readAll_('Drivers').filter(function (d) { return d["สถานะ"] !== 'พ้นจากหน้าที่'; }).map(function (d) {
    const id = String(d["รหัสพนักงาน"]);
    const name = String(d["ชื่อ-นามสกุล"]);
    const clash = busy.filter(function (x) { return String(x["รหัสพนักงานขับรถ"]) === id || (!x["รหัสพนักงานขับรถ"] && x["พนักงานขับรถ"] === name); });
    let reason = '';
    const exp = String(d["วันหมดอายุใบอนุญาต"] || '').slice(0, 10);
    if (d["สถานะ"] === 'ลา/ไม่พร้อมปฏิบัติงาน') reason = 'ลาหรือไม่พร้อมปฏิบัติงาน';
    else if (exp && endDate && exp < endDate) reason = 'ใบอนุญาตขับขี่หมดอายุ ' + exp;
    else if (clash.length) reason = 'มีภารกิจซ้อนเวลา ' + clash.map(function (c) { return c["เลขที่คำขอ"]; }).join(', ');
    return { id: id, name: name, phone: d["เบอร์โทร"], status: d["สถานะ"], available: !reason, reason: reason };
  });

  return { vehicles: vehicles, drivers: drivers };
}

/**
 * ตรวจสอบรถว่างในช่วงเวลา
 * รถว่าง = รถที่ไม่ซ่อมบำรุง ไม่มีคำขอที่จัดรถไว้แล้วซ้อนเวลา และมีที่นั่งพอ
 * จากนั้นหักคำขอที่ยังรอหัวหน้ายานจัดรถในช่วงเวลาเดียวกัน (คิวรอจัดรถ)
 */
function availability_(start, end, passengers, excludeReqNo) {
  const period = { start: start, end: end };
  const reqs = readAll_('Requests').filter(function (x) {
    return String(x["เลขที่คำขอ"]) !== String(excludeReqNo || '') && overlap_(periodOf_(x), period);
  });
  const held = reqs.filter(function (x) { return HOLD_STATUSES.indexOf(x["สถานะ"]) >= 0; });
  const queue = reqs.filter(function (x) { return x["สถานะ"] === ST.WAIT_FLEET; });

  const vehicles = readAll_('Vehicles').filter(function (v) { return v["สถานะ"] !== 'เลิกใช้งาน'; }).map(function (v) {
    const id = String(v["รหัสรถ"]), plate = String(v["ทะเบียนรถ"]);
    const busy = held.filter(function (x) { return String(x["รหัสรถ"]) === id || (!x["รหัสรถ"] && x["รถยนต์ที่จัดสรร"] === plate); })
      .map(function (x) {
        return { reqNo: x["เลขที่คำขอ"], from: x["วันที่เดินทาง"] + ' ' + x["เวลาเดินทาง"], to: x["วันที่กลับ"] + ' ' + x["เวลากลับ"], status: x["สถานะ"], destination: x["สถานที่ปลายทาง"] };
      });
    const maintenance = v["สถานะ"] === 'ซ่อมบำรุง';
    const seatOk = !Number(v["จำนวนที่นั่ง"]) || Number(v["จำนวนที่นั่ง"]) >= passengers;
    return {
      id: id, plate: plate, model: v["ยี่ห้อ/รุ่น"], type: v["ประเภทรถ"], seats: v["จำนวนที่นั่ง"],
      maintenance: maintenance, seatOk: seatOk, busy: busy,
      free: !maintenance && busy.length === 0
    };
  });
  const freeFit = vehicles.filter(function (v) { return v.free && v.seatOk; }).length;
  const freeAll = vehicles.filter(function (v) { return v.free; }).length;
  const remaining = freeFit - queue.length;
  let message;
  if (!vehicles.length) message = 'ยังไม่มีข้อมูลรถในระบบ';
  else if (remaining > 0) message = 'มีรถว่าง ' + remaining + ' คัน สามารถขอใช้รถได้';
  else if (freeFit > 0) message = 'รถที่ว่างมีคำขออื่นรอจัดรถอยู่ครบแล้ว (' + queue.length + ' รายการ) กรุณาเลือกช่วงเวลาอื่น';
  else if (freeAll > 0) message = 'รถที่ว่างมีที่นั่งไม่พอสำหรับผู้โดยสาร ' + passengers + ' คน';
  else message = 'รถทุกคันไม่ว่างในช่วงเวลานี้';
  return { canRequest: remaining > 0, remaining: Math.max(remaining, 0), freeCount: freeFit, queue: queue.length, message: message, vehicles: vehicles };
}

function findVehicle_(r) {
  return readAll_('Vehicles').filter(function (v) {
    return (r["รหัสรถ"] && String(v["รหัสรถ"]) === String(r["รหัสรถ"])) || (!r["รหัสรถ"] && v["ทะเบียนรถ"] === r["รถยนต์ที่จัดสรร"]);
  })[0] || null;
}

function findDriver_(r) {
  return readAll_('Drivers').filter(function (d) {
    return (r["รหัสพนักงานขับรถ"] && String(d["รหัสพนักงาน"]) === String(r["รหัสพนักงานขับรถ"])) || (!r["รหัสพนักงานขับรถ"] && norm_(d["ชื่อ-นามสกุล"]) === norm_(r["พนักงานขับรถ"]));
  })[0] || null;
}

function uploadImageToDrive_(base64Data, fileName, folderKey) {
  try {
    if (!base64Data) return '';
    if (String(base64Data).length > 8 * 1024 * 1024) throw new Error('ไฟล์ภาพมีขนาดใหญ่เกินไป');
    const folder = folder_(folderKey);
    const contentType = base64Data.substring(5, base64Data.indexOf(';'));
    if (contentType.indexOf('image/') !== 0) throw new Error('รองรับเฉพาะไฟล์รูปภาพ');
    const bytes = Utilities.base64Decode(base64Data.split(',')[1]);
    const file = folder.createFile(Utilities.newBlob(bytes, contentType, fileName));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://lh3.googleusercontent.com/d/' + file.getId();
  } catch (e) {
    throw new Error('เกิดข้อผิดพลาดในการอัปโหลดไฟล์ภาพ: ' + e.message);
  }
}

// ---------- ลายมือชื่อ ----------
function sigTarget_(u, username) {
  const target = String(username || '').trim().toLowerCase();
  if (!target || target === u.username) return u.username;
  if (u.role !== 'admin') throw new Error('จัดการได้เฉพาะลายเซ็นของตนเองเท่านั้น');
  return target;
}

function sigFolder_() { return folder_('SIGNATURE_FOLDER_ID'); }

// อ่านค่าการตั้งค่า: Script Properties ก่อน แล้วจึงใช้ค่าในโค้ด
function cfg_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || DEFAULT_IDS[key] || '';
}

// คืนโฟลเดอร์ตามคีย์ ถ้าไม่มีหรือถูกลบ จะสร้างใหม่และจำไว้ใน Script Properties
function folder_(key) {
  const id = cfg_(key);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* โฟลเดอร์ถูกลบ สร้างใหม่ */ }
  }
  const folder = DriveApp.createFolder(FOLDER_NAMES[key] || key);
  PropertiesService.getScriptProperties().setProperty(key, folder.getId());
  return folder;
}

function saveSigImage_(dataUrl, fileName) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+\/=]+)$/);
  if (!m) throw new Error('รูปแบบไฟล์ลายเซ็นไม่ถูกต้อง');
  if (m[2].length > 2 * 1024 * 1024) throw new Error('ไฟล์ลายเซ็นมีขนาดใหญ่เกินไป');
  if (m[2].length < 200) throw new Error('ไม่พบลายมือชื่อ กรุณาลงนามใหม่');
  const file = sigFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], fileName));
  return file.getId(); // ไม่ตั้งค่าแชร์ ไฟล์จึงเปิดได้เฉพาะเจ้าของสคริปต์
}

function sigDataUrl_(fileId) {
  if (!fileId) return '';
  try {
    const blob = DriveApp.getFileById(String(fileId)).getBlob();
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    return '';
  }
}

function trashFile_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(String(fileId)).setTrashed(true); } catch (e) { /* ไฟล์ไม่มีแล้ว */ }
}

/**
 * แปลงข้อมูลการลงนามจากหน้าเว็บเป็นไฟล์ลายเซ็นที่ผูกกับคำขอ
 * sign.mode = 'saved' ใช้ลายเซ็นสแกนประจำตัว (คัดลอกเป็นไฟล์ใหม่ เพื่อไม่ให้เอกสารเดิมเปลี่ยนเมื่อผู้ใช้เปลี่ยนลายเซ็น)
 * sign.mode = 'draw'  ลงนามบนอุปกรณ์ ณ เวลานั้น
 */
function resolveSignature_(u, sign, label, reqNo, required) {
  sign = sign || {};
  const base = label + '_' + reqNo + '_' + u.username + '_' + Date.now();
  if (sign.mode === 'saved') {
    const row = findUserRow_(u.username);
    const fid = row && row["ไฟล์ลายเซ็น"];
    if (!fid) throw new Error('ท่านยังไม่มีลายเซ็นสแกนในระบบ กรุณาบันทึกที่เมนูข้อมูลส่วนตัว หรือเลือกเซ็นบนอุปกรณ์');
    let copy;
    try { copy = DriveApp.getFileById(String(fid)).makeCopy(base + '.png', sigFolder_()); }
    catch (e) { throw new Error('ไม่พบไฟล์ลายเซ็นสแกนของท่าน กรุณาบันทึกลายเซ็นใหม่'); }
    return { id: copy.getId(), method: 'ลายเซ็นสแกน' };
  }
  if (sign.mode === 'draw') {
    if (!sign.data) throw new Error('กรุณาลงลายมือชื่อในกรอบลงนาม');
    return { id: saveSigImage_(sign.data, base + '.png'), method: 'ลงนามบนอุปกรณ์' };
  }
  if (required) throw new Error('ขั้นตอนนี้ต้องลงลายมือชื่อ กรุณาเลือกวิธีลงนาม');
  return null;
}

// ---------- บันทึกประวัติ ----------
function log_(u, action, detail) {
  try {
    appendObj_('Logs', {
      "วันเวลา": now_(), "ชื่อผู้ใช้": u.username, "ชื่อ-นามสกุล": u.name,
      "บทบาท": ROLE_LABELS[u.role] || u.role, "การดำเนินการ": action, "รายละเอียด": String(detail || '').slice(0, 500)
    });
  } catch (e) { console.error(e); }
}

// ---------- จัดการชีต ----------
let SS_CACHE_ = null;
let SETUP_RUNNING_ = false;
function ss_() {
  if (!SS_CACHE_) SS_CACHE_ = openBook_();
  return SS_CACHE_;
}

// เปิดสเปรดชีต: ตาม SPREADSHEET_ID / สเปรดชีตที่ผูกสคริปต์ไว้ / หรือสร้างใหม่ (เฉพาะตอนรัน setupSystem)
function openBook_() {
  const id = cfg_('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  let book = null;
  try { book = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { book = null; }
  if (!book) {
    if (!SETUP_RUNNING_) throw new Error('ยังไม่ได้ตั้งค่าฐานข้อมูล กรุณาให้ผู้ดูแลรัน setupSystem ใน Apps Script ก่อน');
    book = SpreadsheetApp.create('ฐานข้อมูล ' + APP_NAME);
  }
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', book.getId());
  return book;
}

function ensureSheet_(book, name, headers) {
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = headers.filter(function (h) { return current.indexOf(h) < 0; });
  if (missing.length) {
    const startCol = current.filter(function (h) { return h !== ''; }).length ? sh.getLastColumn() + 1 : 1;
    if (sh.getMaxColumns() < startCol + missing.length - 1) sh.insertColumnsAfter(sh.getMaxColumns(), startCol + missing.length - 1 - sh.getMaxColumns());
    sh.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#e8f0fe');
  }
  sh.setFrozenRows(1);
  return sh;
}

function sheet_(name) {
  const book = ss_();
  return book.getSheetByName(name) || ensureSheet_(book, name, SCHEMA[name]);
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
}

function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    const o = { _row: i + 1 };
    for (let j = 0; j < headers.length; j++) {
      if (headers[j]) o[headers[j]] = fmtCell_(row[j]);
    }
    out.push(o);
  }
  return out;
}

function appendObj_(name, obj) {
  const sh = sheet_(name);
  let headers = headers_(sh);
  const missing = Object.keys(obj).filter(function (k) { return headers.indexOf(k) < 0; });
  if (missing.length) { ensureSheet_(ss_(), name, SCHEMA[name]); headers = headers_(sh); }
  const row = headers.map(function (h) { return toCell_(obj.hasOwnProperty(h) ? obj[h] : ''); });
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function updateObj_(name, rowNum, patch) {
  const sh = sheet_(name);
  let headers = headers_(sh);
  if (Object.keys(patch).some(function (k) { return headers.indexOf(k) < 0; })) {
    ensureSheet_(ss_(), name, SCHEMA[name]);
    headers = headers_(sh);
  }
  const range = sh.getRange(rowNum, 1, 1, headers.length);
  const values = range.getValues()[0];
  Object.keys(patch).forEach(function (k) {
    const idx = headers.indexOf(k);
    if (idx < 0) throw new Error('ไม่พบคอลัมน์ ' + k + ' ในชีต ' + name);
    values[idx] = patch[k];
  });
  range.setValues([values.map(toCell_)]);
}

function stripRow_(o) {
  const c = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; });
  return c;
}

// ---------- ยูทิลิตี ----------
function tz_() { return Session.getScriptTimeZone() || 'Asia/Bangkok'; }
function now_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'); }
// ปีงบประมาณ พ.ศ. (เริ่ม 1 ตุลาคม)
function fiscalYearBE_() {
  const d = new Date();
  return d.getFullYear() + 543 + (d.getMonth() >= 9 ? 1 : 0);
}
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }

function fmtCell_(v) {
  if (v instanceof Date) {
    if (v.getFullYear() < 1901) return Utilities.formatDate(v, tz_(), 'HH:mm');
    const hm = Utilities.formatDate(v, tz_(), 'HH:mm');
    return hm === '00:00' ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd') : Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm');
  }
  return v;
}

// เก็บสตริงที่เป็นตัวเลข วันที่ เวลา หรือเบอร์โทร เป็นข้อความ เพื่อไม่ให้เลข 0 นำหน้าหายหรือถูกแปลงรูปแบบ
function toCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v !== '' && v.charAt(0) !== "'" && /^[\d\s+\-:\/.]+$/.test(v)) return "'" + v;
  if (typeof v === 'string' && /^[=+\-@]/.test(v) && !/^[\d\s+\-:\/.]+$/.test(v)) return "'" + v; // ป้องกันการแทรกสูตร
  return v;
}

function parseDT_(dateStr, timeStr) {
  const d = String(dateStr || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d) return null;
  const t = String(timeStr || '00:00').match(/(\d{1,2}):(\d{2})/) || [0, 0, 0];
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
}

function nextCode_(list, key, prefix) {
  let max = 0;
  list.forEach(function (r) {
    const s = String(r[key]);
    if (s.indexOf(prefix) === 0) max = Math.max(max, Number(s.slice(prefix.length)) || 0);
  });
  return prefix + String(max + 1).padStart(2, '0');
}

function clean_(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 500);
}

function norm_(s) { return String(s || '').replace(/\s+/g, '').trim(); }

function appendNote_(old, text) {
  return (old ? String(old) + ' | ' : '') + text;
}
