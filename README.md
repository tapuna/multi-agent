# Relay — Multi-Agent Engineering Control Center

ระบบจัดการงานและ AI agents สำหรับใช้งานบนเครื่องเดียว ใช้ **TypeScript, Next.js, Fastify, LangGraph JavaScript และ Firebird Embedded 5** โดย Kanban เป็นแหล่งข้อมูลหลักของงาน

## เริ่มใช้งาน

ต้องมี **Node.js 22+ แบบ x64**, npm และ Git ใช้ Windows x64 ได้โดยไม่ต้องติดตั้ง Docker หรือ database server

เปิด PowerShell ในโฟลเดอร์โปรเจกต์ แล้วรัน:

```powershell
node --version
npm ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
npm run setup:firebird
npm run dev
```

เปิด [แอป](http://127.0.0.1:3000) คำสั่ง `dev` เปิดทั้ง API และหน้าเว็บ กด Ctrl+C เพื่อหยุดทั้งคู่ อ่านสถานะฐานข้อมูลได้ที่ [health](http://127.0.0.1:8000/health) และผ่าน `/api/system` จากหน้าเว็บ

`setup:firebird` ดาวน์โหลด engine เวอร์ชันที่ระบุในสคริปต์ ตรวจ SHA-256 แล้วเก็บใน `.data/firebird-runtime` โดยไม่ติดตั้ง service หากมี engine แล้วจะไม่ดาวน์โหลดซ้ำ การติดตั้งครั้งแรกต้องใช้อินเทอร์เน็ต

ไฟล์ `.env` ตัวอย่างเริ่มโดยปิด agent execution และไม่มี profile จึงเปิด board ได้ก่อนตั้งค่าโมเดล ตัว launcher สร้าง operator/service keys ชั่วคราวให้เมื่อไม่ได้ตั้งเอง ค่าเหล่านี้ไม่พิมพ์ใน log

## ตั้งค่า LLM และลงทะเบียน agent

1. แก้ `.env` ที่ root กำหนด `LLM_PROFILES_JSON` เป็น JSON array ตามตัวอย่างในไฟล์ และใส่ key จริงในตัวแปรที่ `api_key_env` อ้างถึง
2. เมื่อต้องการทดสอบหรือเรียกโมเดล ตั้ง `AGENT_EXECUTION_ENABLED=1` แล้ว restart แอป
3. เปิด **Configuration → Runtime adapter setup** แต่ละรายการใน array จะแสดงเป็นการ์ด กด **Test LLM** ของ profile ที่ต้องการจนเป็น **Ready**
4. เปิด **Agent Studio → Register/Edit agent** เลือก runtime และ profile ที่ Ready แล้วกำหนด role และ Skills ให้ agent นั้น

แต่ละ profile ต้องผ่านการทดสอบของตัวเอง ผลผ่านของ A ไม่ปลดล็อก B แม้ใช้ runtime เดียวกัน เปลี่ยน model, endpoint, credential หรือปิด profile แล้ว restart จะต้องตรวจความพร้อมใหม่ การกดทดสอบเรียก provider จริงและอาจมีค่าบริการ การเปิดหน้าจอเฉย ๆ ไม่เรียกโมเดล

| Runtime                       | การตั้งค่า                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`                         | OpenAI-compatible endpoint, Anthropic Messages หรือ Gemini GenerateContent ผ่าน gateway TypeScript                                                       |
| `codex` / `claude` / `gemini` | ติดตั้ง CLI และ login บนเครื่องก่อน ไม่ใส่ `model` ได้เพื่อให้ CLI ใช้ default หรือใส่ model ID เพื่อตรึงรุ่น ไม่ใส่ `api_base`/`api_key_env` ใน profile |

API profile เลือก endpoint/key แยกจากกัน Native API ใช้ prefix `openai/`, `anthropic/`, `gemini/` หรือ provider ที่รองรับใน gateway สำหรับ OpenAI-compatible provider อื่นให้ใช้ `openai/<model-id>` พร้อม `api_base` ที่ลงท้ายถึง API version เช่น `/v1` โดยไม่ใส่ `/chat/completions`

CLI profile ที่ไม่ระบุ `model` จะแสดง **CLI default** และไม่ส่ง `--model` ให้ CLI เลือก default ของตัวเอง ไม่ได้เลือกโมเดลตามความยากของงาน ส่วน API profile ยังต้องระบุ model สำหรับ Codex ตัว adapter คง `--ignore-user-config` ไว้ จึงไม่โหลด model จาก `config.toml` ส่วนตัว หากต้องการตรึงรุ่นให้ระบุ model ใน profile

เก็บ key เฉพาะ `.env` หรือ environment ของเครื่อง ไม่ใส่ key ตรงใน JSON, task หรือ repository ข้อมูล profile ที่ browser ได้รับไม่มีค่า key

## ใช้งานงานและ agents

- **Task board:** สร้าง project/task, assignment, priority, sprint, dependency และเปลี่ยนสถานะงาน
- **Workflow:** เลือกเป็นรายงานหรือใช้ project default; ถ้าไม่เลือกใช้ built-in default รองรับ 1–12 steps และทำพร้อมกันได้สูงสุด 3 nodes ตาม dependency
- **Start workflow:** เริ่มจากปุ่มใน task ยังไม่มีระบบหยิบงานจาก board อัตโนมัติ ดูตัวที่กำลังทำและ handoff ใน Task Detail / Execution Monitor
- **Human review:** agents สร้าง artifacts และไฟล์ใน workspace แยก ก่อนหยุดรอคนอนุมัติ การ Merge เป็นปุ่มแยกสำหรับ local fast-forward ของไฟล์ที่ผ่าน review ไม่มี push/deploy อัตโนมัติ
- **Agent Studio:** จัด Skills แยกตาม agent, คุยผ่าน Chat & context และให้สร้าง context summary พร้อมแหล่งข้อมูล ข้อมูลแชตแยกตาม project/agent
- **Context / Skills / Audit:** policy บริษัทมีลำดับสูงสุด, memory ใช้ร่วมระดับ project, Skills เป็น versioned `SKILL.md` และ audit เป็น append-only

## คำสั่งที่ใช้บ่อย

| คำสั่ง                           | หน้าที่                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run dev`                    | เปิด API จาก TypeScript และ Next.js development server; แก้ backend หรือ `.env` ให้ restart |
| `npm run build` แล้ว `npm start` | build และเปิดแบบ compiled local run                                                         |
| `npm run migrate`                | เตรียม/adopt schema โดยไม่ seed ข้อมูล; startup เรียกให้อยู่แล้ว                            |
| `npm run seed`                   | เพิ่ม project ตัวอย่างและ 3 tasks เมื่อยังไม่มี project key `RELAY`                         |
| `npm run typecheck`              | compile backend และตรวจ TypeScript frontend                                                 |
| `npm test`                       | smoke test ชุดเล็กด้วย Firebird จริงและ HTTP provider จำลองในเครื่อง                        |

หยุดแอปก่อน build บน Windows หรือรัน migration/seed แยก process เพื่อเลี่ยง file locks คำสั่ง PowerShell เดิม `./scripts/dev.ps1` และ `./scripts/dev.ps1 -Production` ยังเป็น wrapper ของ Node launcher

## ข้อมูลและการส่งต่องาน

| ตำแหน่ง             | ข้อมูล                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `.data/control.fdb` | projects, tasks, agents, sessions, conversations, approvals, audit, artifacts และ checkpoints |
| `workspaces/`       | workspace แยกตามงาน/agent รวมถึง Git worktrees                                                |
| `contexts/`         | company, team, project, role และ task context                                                 |
| `skills/`           | แพ็กเกจ `SKILL.md` และ versions                                                               |
| `.env`              | คอนฟิกและ credentials เฉพาะเครื่อง ไม่อยู่ใน Git                                              |

หยุดทุก process ที่เปิดฐานข้อมูลก่อนสำรอง `.fdb` เก็บ workspace/context/skills ไปด้วย การ clone repository ไม่รวมฐานข้อมูล, `.env`, dependencies หรือ workspace เดิม ต้องส่งข้อมูลเหล่านี้แยกเมื่อจำเป็น

อ่าน [handoff สำหรับผู้รับงาน](docs/HANDOFF.md), [คู่มือใช้งาน](docs/USER_GUIDE_TH.md), [รายละเอียด Firebird](docs/FIREBIRD.md) และ [สถานะ implementation/validation](docs/IMPLEMENTATION_STATUS.md)

## ขอบเขตปัจจุบัน

แอปนี้ใช้แบบ local single operator ยังไม่มี multi-user production auth, task comment threads, auto task pickup, arbitrary generated shell/test execution, deployment executor หรือ vector search ใช้ Firebird Embedded เป็นฐานข้อมูลของ build นี้

Build และ smoke test ของเวอร์ชัน Node ผ่านบน Windows แล้ว แต่ยังไม่ได้ยืนยันโมเดล cloud จริง, S3 replication หรือ Linux/container execution มีไฟล์ Compose และ CI ให้พัฒนาต่อ แต่การรันบนเครื่องไม่ต้องใช้ Docker ดูรายการค้างและรายละเอียดการย้าย checkpoint ใน handoff
