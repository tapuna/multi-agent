# คู่มือใช้งาน Relay

## เริ่มรัน

ใช้ Node.js 22 ขึ้นไปแบบ x64 และ Git เปิด PowerShell ในโฟลเดอร์โปรเจกต์:

```powershell
npm ci
npm run setup:firebird
npm run dev
```

เปิด http://127.0.0.1:3000 คำสั่งเดียวเปิดทั้งหน้าเว็บและ API กด Ctrl+C เพื่อหยุดทั้งคู่ ไม่ต้องติดตั้ง database server หรือ Docker

หากต้องการแบบ build แล้ว:

```powershell
npm run build
npm start
```

ใช้ `./scripts/dev.ps1 -Production` ได้เหมือนเดิม ข้อมูลเก็บใน `.data/control.fdb` ส่วน engine อยู่ `.data/firebird-runtime` แยกจาก runtime ภาษาอื่น หากต้องการตัวอย่างงานใช้ `npm run seed` ซึ่งไม่เขียนทับโปรเจกต์เดิม

## ตั้งค่า LLM และ agent

1. ตั้ง `LLM_PROFILES_JSON` ใน `.env` ที่ root เป็น array ตาม `.env.example` แต่ละรายการมี id, label, runtime, model, enabled และ API ใช้ api_base/api_key_env ได้
   หากยังไม่กำหนด `AGENT_EXECUTION_ENABLED` ระบบเริ่มปิดการเรียก agent ไว้ ตั้ง `AGENT_EXECUTION_ENABLED=1` เมื่อพร้อมใช้งาน provider แล้ว restart
2. `api_key_env` คือชื่อ environment variable ที่เก็บ key จริง ไม่ใส่ key ใน JSON หรือข้อความงาน ค่า key ไม่ส่งไป browser
3. Restart แอป แล้วเปิด Configuration → Runtime adapter setup จะเห็นการ์ดตามรายการใน JSON
4. กด **Test LLM** ของแต่ละ profile ให้เป็น **Ready** ก่อน การผ่าน A ไม่เปิด B แม้ใช้ runtime เดียวกัน การทดสอบเรียก provider จริงและอาจมีค่าบริการ
5. Agent Studio → Register/Edit agent เลือก runtime และ profile ที่ Ready แล้วตั้งชื่อกับ role
6. กด Skills บนการ์ดเพื่อเลือกแพ็กเกจเฉพาะ agent นั้น เลือกได้ไม่เกิน 10 และหนึ่ง version ต่อชื่อ

เปลี่ยน model, endpoint, key หรือปิด profile แล้ว restart จะต้องทดสอบใหม่ หาก agent เดิมใช้ไม่ได้จะมีคำเตือนและ backend บล็อกจริง CLI ใช้ login ของ CLI เอง กำหนด CODEX_BIN/CLAUDE_BIN/GEMINI_BIN ได้ รองรับ native executable กับ npm shim มาตรฐาน

API gateway รองรับ OpenAI-compatible/local endpoint, Anthropic และ Gemini โดยตรง Provider อื่นที่ compatible ให้ใช้ `openai/<model>` และระบุ api_base ไม่ได้รองรับ integration ทั้งหมดของ gateway เดิม

## ใช้งาน task และ workflow

สร้าง Project → Create task → กรอกคำอธิบายและ acceptance criteria → เลือก workflow หรือใช้ default

ลำดับ default คือ task > project > built-in สามารถตั้ง workflow ให้แต่ละงานต่างกันได้ ระบบตรวจวงจรและ dependency การกำหนด agent ต่อ step แสดงให้ตรวจได้ก่อน Start ไม่ได้หยิบงานจาก board อัตโนมัติ

กด **Start workflow** เพื่อเริ่ม Agent ทำงานตาม dependencies โดยพร้อมกันได้สูงสุด 3 steps ดูตัวที่กำลังทำ ผลงาน และ handoff ใน Task Detail / Execution Monitor ระบบบันทึกเหตุการณ์และ artifact แต่ยังไม่มี comment thread ใน task

เมื่อ agents เสร็จ ระบบหยุดรอคน Review ผลงานและไฟล์ กดอนุมัติหรือปฏิเสธให้ตรง digest ปัจจุบัน หากอนุมัติแล้วและมี Git repository กด Merge แยกต่างหากได้เฉพาะ local fast-forward ไม่มี push/deploy อัตโนมัติ

แอปหยุดกลางงานจะเป็น interrupted ไม่เรียกโมเดลซ้ำเอง กด Resume เพื่อทำต่อจาก checkpoint/ผล step ที่บันทึก หาก policy, task หรือ profile เปลี่ยนให้เริ่ม run ใหม่

## คุยและตรวจบริบท

Agent Studio → **Chat & context** แยกประวัติตาม project/agent กด **Generate context summary** ให้ agent สรุปจากบริบทที่ส่งให้ พร้อมสิ่งที่ไม่รู้และ source IDs Inventory แสดง policy, project memory, skills และ artifacts ของตัวเอง ไม่ใช่คะแนนวัดความรู้ที่โมเดลเคยฝึก

Readiness → Test บนการ์ดเป็นการตรวจ agent เพิ่มเติม ส่วนการปลดล็อก profile ก่อน Register อยู่ที่ Configuration

## หลังย้าย backend

ข้อมูลเดิมยังอยู่ แต่ต้อง Test LLM ใหม่ Agent ที่เคยใส่ model ID ตรงต้องเปลี่ยนเป็น profile ที่ผ่านแล้ว Checkpoint จาก runtime เดิมเก็บเป็นประวัติ ส่วน JavaScript ใช้ namespace ใหม่ หาก run เดิมมี snapshot ไม่เข้ากันให้ Cancel แล้วเริ่มใหม่ ไม่ใช้โค้ดเดิมเป็น backend แล้ว

## ตรวจเฉพาะที่จำเป็น

`npm run typecheck` ตรวจ TypeScript และ `npm test` รัน smoke test ชุดเล็กด้วย provider จำลองในเครื่อง คุณตรวจการใช้งานจริงเองได้ก่อน ไม่ต้องรันชุดทดสอบใหญ่ทุกครั้ง

ก่อนสำรองไฟล์ `.fdb` ให้หยุดแอปและ API ทั้งหมดก่อน ห้ามเปิดบริการเก่าซ้อนกับแอปใหม่บนฐานข้อมูลเดียวกัน
