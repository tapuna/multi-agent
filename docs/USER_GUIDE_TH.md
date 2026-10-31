# คู่มือ Relay — Multi-Agent Engineering Control Center

ระบบใช้ Firebird Embedded บันทึกงาน การรัน agent, checkpoint, ผลงาน และ audit จริง ไม่ต้องติดตั้ง Docker หรือ database server ข้อมูลหลักอยู่ที่ `D:\Multi-agent\.data\control.fdb`

## เปิดระบบ

เครื่องนี้ติดตั้ง dependencies แล้ว เปิด PowerShell:

```powershell
cd D:\Multi-agent
.\scripts\dev.ps1 -Production
```

เปิด [หน้าแอป](http://127.0.0.1:3000) และ [API docs](http://127.0.0.1:8000/docs) เก็บ PowerShell ไว้ กด Ctrl+C เพื่อหยุด หากเปิดอยู่แล้วไม่ต้องรันซ้ำ หากแก้ frontend ให้หยุดแอปแล้วรัน `npm run build` ก่อนเปิดแบบ `-Production` หรือใช้ `.\scripts\dev.ps1` สำหรับ development

## ตั้งค่าโมเดลครั้งแรก

หน้า Configuration แสดง runtime ที่ติดตั้ง การติดตั้ง CLI กับการล็อกอินเป็นคนละขั้นตอน ตอนตรวจส่งมอบพบ Codex CLI แต่ยังไม่ล็อกอิน ส่วน Claude/Gemini CLI ยังไม่มี และยังไม่มี API key ต้องเลือกวิธีใดวิธีหนึ่ง:

1. **Codex CLI:** รัน `codex login` และล็อกอินด้วยตัวเอง จากนั้น Agent studio → แก้ไข/สร้าง agent → เลือก runtime `codex` และ model ID ที่บัญชีใช้ได้ หากหา executable ไม่พบ ตั้ง `CODEX_BIN` ใน `.env`
2. **API ผ่าน LiteLLM:** ตั้ง provider key เช่น `OPENAI_API_KEY` หรือ `ANTHROPIC_API_KEY` ใน `.env` ที่ root ด้วย editor บนเครื่อง ใช้ runtime `api` และชื่อพร้อม provider prefix เช่น `openai/<model-id>` ห้ามส่ง key ผ่านแชตหรือใส่ในคำอธิบายงาน
3. **โมเดล local ที่มี OpenAI-compatible endpoint:** ตั้ง `LLM_API_BASE=http://127.0.0.1:<port>/v1` และ `LLM_API_KEY` ตาม endpoint ใช้ runtime `api` กับ `openai/<local-model-id>` ต้องเปิด model server ที่เลือกเอง

หลังแก้ `.env` ให้ restart แอป ชื่อ model ตัวอย่าง `configure-before-execution` ใช้รันจริงไม่ได้ ต้องเปลี่ยนก่อน Claude/Gemini ต้องติดตั้งและยืนยันตัวตนก่อนเช่นกัน แอปไม่ล็อกอินบัญชีแทนคุณ

## เริ่มงานจนจบ

1. สร้าง/เลือก Project แล้วสร้าง Task ระบุผลลัพธ์และ acceptance criteria ตั้ง priority, sprint และ dependencies ได้
2. Agent studio: ลงทะเบียน Planner, Builder, Reviewer พร้อม runtime/model ของแต่ละตัว
3. Context hub: ใส่บริบท company/team/project/role/task และ shared memory นโยบายบริษัทเป็นข้อบังคับระดับบน การแก้ context มี audit และตรวจ revision
4. Skill registry: ตรวจหรือเผยแพร่แพ็กเกจ `SKILL.md` ใช้เวอร์ชันใหม่เมื่อแก้ไข เลือก skill/เวอร์ชันให้แต่ละ agent ที่ Agent studio และเก็บ snapshot เนื้อหาจริงตอนเริ่ม run
5. หากต้องการแก้ repo เดิม ไป Configuration ระบุ path ของ **local Git repository** ระบบ pin HEAD และสร้าง detached worktree แยก หากไม่ผูก repo จะสร้างโฟลเดอร์งานแยกและดาวน์โหลด ZIP ได้
6. เปิด Task → Agent workflow เลือก Standard (Plan → Implement → Review), Direct (Implement → Review) หรือ Parallel (Frontend + Backend → Review) เลือก agent (ใช้ skill ที่ตั้งให้แต่ละตัว) แล้วกด **Start workflow**
7. ดูการ์ด Kanban, Orchestration หรือ Execution monitor เพื่อเห็นชื่อ agent ที่ทำงาน เวลาเริ่ม/จบ session ID, events, errors และ artifacts ไป Workspaces เพื่ออ่านไฟล์หรือดาวน์โหลด ZIP
8. เมื่อ **Awaiting human review** ตรวจผลงานและทดสอบโครงการจริง กด **Approve & complete task** เพื่อจบ หรือ **Needs revision** เพื่อคืนงาน ไม่ merge/deploy อัตโนมัติ
9. งานที่ผูก Git repo และอนุมัติแล้วมีปุ่ม merge แยกสำหรับคน ระบบตรวจ hash/เวอร์ชัน/ไฟล์/HEAD/repo สะอาด แล้ว fast-forward เฉพาะ local repo ไม่ push/deploy ถ้า repo เปลี่ยนให้เริ่ม run ใหม่จาก revision ปัจจุบัน

## Agent ตัวไหนหยิบงาน และเริ่มจากตัวแรกเสมอไหม

Agent ไม่สุ่มหยิบทุกงาน และไม่เริ่มจากตัวแรกใน Agent studio ต้องกด Start workflow ของ task ก่อน ระบบเริ่มขั้นที่ dependency พร้อม:

- Standard เริ่ม Planner → Builder → Reviewer
- Direct เริ่ม Builder ได้ทันที
- Parallel เริ่ม Frontend/Backend พร้อมกัน Reviewer รอทั้งคู่
- API รองรับ DAG กำหนดเองสูงสุด 12 ขั้น และรันอิสระพร้อมกันสูงสุด 3 ขั้น

แต่ละขั้นมี `agent.queued` เมื่อเข้าคิว, `agent.started` เมื่อรับงานจริง, `agent.completed` และ `handoff.ready` เมื่อส่งต่อ การ์ดแสดงชื่อ agent ที่ running และ Monitor มีเวลา/session จึงแยกรอคิวกับเริ่มแล้วได้ ไม่ต้องเดาจากลำดับรายชื่อ

## งานล้มเหลวหรือปิดแอประหว่างรัน

- Cancel workflow ก่อนแก้ task ที่มี run ค้าง ผลที่มาหลังยกเลิกจะไม่ถูกนำไปจบงาน
- Failed/Interrupted มี Resume ใช้ checkpoint/session เดิม ไม่เรียกขั้นสำเร็จซ้ำโดยไม่จำเป็น CLI ใช้ provider session ID จริง ส่วน API เก็บบทสนทนาใน Firebird ไม่ปลอม response ID เป็น session ID
- หลัง restart งาน running กลายเป็น Interrupted ให้คนตรวจแล้วกด Resume เอง ป้องกันเรียกโมเดลเสียเงินซ้ำอัตโนมัติ
- หากนโยบายบริษัท/ไฟล์ที่อนุมัติ/task version เปลี่ยน ระบบปฏิเสธ ให้เริ่ม run ใหม่จากข้อมูลปัจจุบัน
- CLI มี deadline/cancellation; API มี timeout ผลที่ยังเดินทางมาหลังยกเลิกจะถูกทิ้ง ไม่ได้รับรองว่าผู้ให้บริการหยุดคิดเงินทันที

## ข้อมูลและการตรวจสอบ

Lock timeout ค่าเริ่มต้น 5 วินาที (`FIREBIRD_LOCK_TIMEOUT_SECONDS` ตั้งได้ 1–10) ชน lock ตอบ 409 ไม่ replay การเขียน ทุก process ที่ใช้ Firebird runtime เดียวกันต้องใช้ `FIREBIRD_LOCK` directory เดียวกัน สคริปต์จัดให้แล้ว

เก็บ `.data/control.fdb`, `workspaces/`, `contexts/`, `skills/` และ `.env` อย่างปลอดภัย สำรองไฟล์ฐานข้อมูลโดยตรงให้หยุดแอปก่อน และเก็บ backup ของ Firebird แยกจาก source code

Artifacts เก็บ Firebird/filesystem เป็นค่าเริ่มต้น หากใช้ S3 ตั้ง `ARTIFACT_S3_*` ตาม `.env.example` แล้ว restart ถ้า replication ล้มเหลว local ยังอยู่ retry API `/api/workflows/{id}/archive` ได้

```powershell
cd D:\Multi-agent\apps\api
..\..\.venv\Scripts\python.exe -m pytest tests -q
cd ..\..
npm run build
```

Browser QA ใช้ฐานข้อมูลแยกและ HTTP contract provider บนเครื่องเพื่อทดสอบ flow ไม่ใช่โมเดล AI จริง ไม่ได้อ้างว่าทดสอบ cloud ก่อนตั้งบัญชี

รุ่นนี้สำหรับผู้ใช้คนเดียวบนเครื่อง local อย่าเปิดสาธารณะก่อนเพิ่ม identity/RBAC และตรวจ deployment ไม่รันคำสั่งที่โมเดลสร้างอย่างอิสระ test/review agent จึงเป็นการวิเคราะห์ ไม่ใช่หลักฐานว่ารัน test ของโครงการแล้ว ไม่มี automatic push/deploy และไม่มี pgvector search ใน Firebird

## ตั้งค่า Workflow แยกตามงานและ Default

ไป **Orchestration → Workflow configuration** เพื่อสร้าง workflow ใหม่ หรือ Clone จาก built-in แล้วแก้ไข กำหนดชื่อ ขั้นตอนประเภท plan/implement/review/test, instructions, role, default agent และ dependencies ได้สูงสุด 12 ขั้น ขั้นที่ไม่รอใครเริ่มพร้อมกันได้ ขั้นที่เลือกหลาย dependencies จะรอทั้งหมด ระบบปฏิเสธ cycle และ step key ซ้ำ

ตั้ง **Project default workflow** ในหน้านี้ หากเลือก Use system default จะใช้ Plan → Implement → Review งานใหม่และงานที่ไม่ได้เลือก workflow จะสืบทอด default ณ เวลาเริ่มรัน

ใน **Task detail → Agent workflow → Workflow** เลือก workflow เฉพาะงานได้ ตัวเลือกถูกบันทึกลง Firebird ทันที และเพิ่มเวอร์ชัน task เลือก **Use default** เพื่อกลับไปสืบทอด default ของ project หาก project ไม่มี default จะใช้ system default เสมอ แก้ workflow ของงานที่กำลังรันไม่ได้ ต้อง Cancel ก่อน

ลำดับเลือก: **Task selection → Project default → System default** ขั้นตอนก่อน Start แสดง Effective workflow พร้อมที่มา ตรวจเลือก agent แต่ละขั้นก่อนรันได้ ส่วน runtime/model ยังคงเป็นคอนฟิกของ agent ใน Agent Studio จึงผสมหลาย runtime ใน workflow เดียวได้

การแก้ template เพิ่ม version และสร้าง audit; run ที่เริ่มแล้วเก็บ definition/agent assignments/hash เป็น snapshot ไม่เปลี่ยนตาม template ใหม่ ถ้า default หรือเวอร์ชัน workflow เปลี่ยนหลังเปิดหน้า ระบบปฏิเสธการ Start ด้วยข้อมูลเก่า ให้ปิด/เปิด Task detail ใหม่ ทั้ง custom และ built-in ยังต้องผ่าน human review ท้าย workflow เสมอ

API เพิ่มเติม:

- `GET/POST /api/projects/{id}/workflow-templates`
- `PUT /api/projects/{id}/workflow-templates/{template_id}` พร้อม `version`
- `PATCH /api/projects/{id}/default-workflow` พร้อม `version` และ `workflow_template_id` (null = system default)
- `PATCH /api/tasks/{id}` พร้อม task `version` และ `workflow_template_id` (null = inherit)
- `GET /api/tasks/{id}/workflow-config` ดู effective definition และ source
- `POST /api/tasks/{id}/workflows` ส่งแค่ `version` ได้ ระบบ resolve default ให้ หรือส่ง `agent_overrides` ตาม step key; API เดิมที่ระบุ `steps` ยังใช้เป็น ad-hoc workflow ได้

## คุยกับ Agent และ Generate Context Summary

ไป **Agent studio → Chat & context** บนการ์ด agent ที่ต้องการ เลือก Project ด้านบนให้ถูก แล้วพิมพ์ข้อความและกด **Send message** บทสนทนาแยกตาม agent + project และบันทึกใน Firebird เปิดใหม่ยังอ่านได้ ใช้ runtime/model ที่กำหนดให้ agent ตัวนั้น การคุยเป็น text-only ไม่แก้ไฟล์หรือเริ่มงาน Kanban อัตโนมัติ

กด **Generate context summary** เพื่อให้ agent สรุปบริบทปัจจุบัน สิ่งที่รู้/ข้อจำกัด/การตัดสินใจ/งานที่มีหลักฐาน สิ่งที่ยังไม่รู้ และข้อมูลที่ต้องการต่อไป คำตอบใช้แหล่งข้อมูลจาก company policy, team/project/role context, shared project memory, skill packages ที่กำหนดให้ agent และ artifacts ของ agent ตัวนี้ใน project นี้ รวมกับบทสนทนาล่าสุด รายการที่ยังไม่ผ่านคนตรวจมีป้ายระบุชัดเจน การมี skill package ไม่ใช่หลักฐานว่าเคยใช้ skill นั้นแล้ว

**Available context** แสดงจำนวนแหล่งข้อมูล memory, artifacts และ skills ที่ส่งจริงเทียบกับจำนวนที่มี พร้อมขนาด bytes และแจ้งเมื่อข้อมูลถูกตัดตาม budget ตัวเลขนี้ไม่ใช่เปอร์เซ็นต์ความฉลาดหรือความรู้ใน model และไม่สามารถตรวจดู model weights หรือ provider context ภายในได้

กด **Inspect supplied context** ใต้ข้อความเพื่อดู snapshot ที่บันทึกจริงของคำขอนั้น รวม policy hash, เนื้อหาแหล่งข้อมูล, runtime/model และ history ที่ส่ง เมื่อมีข้อความใหม่หลัง summary จะมีป้ายแนะนำให้ generate ใหม่ Summary เก็บเป็นข้อความของ agent ไม่เผยแพร่เข้า shared project memory อัตโนมัติ

CLI ใช้ provider session ID จริงในการสนทนาต่อ ส่วน API ส่ง transcript จากฐานข้อมูล ไม่ปลอม provider session ID เมื่อเปลี่ยน runtime/model/role หรือ company policy จะเริ่ม provider session ใหม่และยังเก็บประวัติเดิมเป็นข้อมูลอ้างอิงระดับล่าง หากปิดแอประหว่างตอบ จะเป็น Interrupted และไม่เรียกซ้ำเสียเงินอัตโนมัติ ส่งคำถามใหม่เพื่อคุยต่อได้ ใช้ **Cancel response** เพื่อยกเลิกและไม่รับคำตอบที่มาช้า

บริบทมี budget: policy สูงสุด 64 KiB, source snippets รวม 96 KB, project memory สูงสุด 20 รายการ, own artifacts 12 รายการ, skills 10 packages และ history ล่าสุดไม่เกิน 30 ข้อความ/48 KB (ต่อข้อความไม่เกิน 6 KB) หน้าจอแสดงล่าสุด 100 ข้อความ ประวัติก่อนหน้ายังเก็บใน Firebird จึงไม่อ้างว่า summary ครอบคลุมทุกอย่างที่เคยคุย

ต้องตั้ง model/auth ของ agent ให้ใช้ได้ก่อน เช่นเดียวกับ workflow การส่งข้อความและกด summary เรียก provider จริงและอาจมีค่าใช้จ่าย ส่วน browser QA ของระบบใช้ local HTTP fixture ที่ติดป้ายชัดเจน ไม่ใช่ live AI inference


## จัดการ Skill ตาม Agent

ไป **Agent studio → Skills** บนการ์ด agent เลือกเวอร์ชันของแต่ละแพ็กเกจ แล้วกด **Save agent skills** เลือก Not assigned เพื่อถอดออก แต่ละ agent มีชุดของตัวเอง ตั้งได้สูงสุด 10 แพ็กเกจ และหนึ่งเวอร์ชันต่อแพ็กเกจ การตั้งค่านี้เป็นของ agent ใช้ข้าม project ที่ agent นั้นทำงานได้ ไม่ใช่ค่าเฉพาะ workflow

**Skill Registry เป็นคลังกลาง** สำหรับ publish/version/read SKILL.md เท่านั้น การ publish ไม่แนบให้ agent ทุกตัว Agent ใหม่และ agent เดิมหลังเปลี่ยนระบบนี้เริ่มด้วยชุดว่าง เลือกเองตามบทบาทได้ เช่น Builder ใช้ implementation skill ส่วน Reviewer ใช้ review skill

workflow จะ snapshot ชุด skill ของแต่ละ agent และคัดลอกเฉพาะชุดนั้นเข้า `.agents/skills/<name>/SKILL.md` ใน workspace ของขั้นนั้น บริบทส่งโมเดลไม่รวมชุด skill ของ agent อื่น (handoff ผลงานยังทำได้ตาม DAG) การแก้ assignment มี audit/optimistic version และไม่เปลี่ยน run/session เก่า

Chat และ Generate context summary ใช้เฉพาะ assigned skills ของตัวนั้น Available context นับเฉพาะชุดนี้ ไม่ได้นับทั้งคลัง เมื่อเปลี่ยน skill provider session ของแชตจะ reset ในคำขอถัดไป และยังเก็บประวัติ/snapshot เก่าไว้

ไม่มีช่อง skill รวมตอน Start workflow อีกต่อไป API ที่ส่ง `skill_refs` ระดับ workflow จะได้ 422 พร้อมวิธีย้ายไปตั้งราย agent แทน ใช้ `GET/PUT /api/agents/{id}/skills` โดย PUT ส่ง `{version, skill_refs: ["name@1.0.0"]}` เวอร์ชันเก่าตอบ 409; แพ็กเกจหายหรือเลือกสองเวอร์ชันชื่อเดียวกันตอบ 422 ทุกชุดยังอยู่ภายใต้นโยบายบริษัท


## ทดสอบ Agent บนการ์ดใน Agent Studio

เปิด **Agent studio** ที่มุม Readiness ของการ์ด agent กด **Test** เพื่อทดสอบเฉพาะตัวนั้น ดูสถานะและเวลาล่าสุดได้บนการ์ด กด **Test details** เพื่อขยายดู preflight, error, latency และ sanitized logs ส่วน Setup/Configuration มีเฉพาะการตั้งและ Verify runtime adapter ก่อนลงทะเบียน agent

ผลแบ่งชัดเจน:

- Preflight: ตรวจ agent/execution เปิดอยู่, พบ CLI, ตั้ง model จริง, model อยู่ใน allowlist และ assigned skills ยังหาเวอร์ชันได้ ไม่ได้ยืนยันการล็อกอินจากการมี CLI หรือ API key
- Not tested: ยังไม่เคยเรียก provider เพื่อพิสูจน์การใช้งาน
- Running: กำลังส่งคำขอสั้นจริงผ่าน runtime/model ของ agent นั้น
- Passed: ได้รับ verification token ใหม่ตรงกับคำขอจริง พร้อมเวลาและ latency
- Blocked: มีคอนฟิกพื้นฐานที่ต้องแก้ก่อน ไม่เรียก provider
- Failed: provider ติดต่อไม่ได้/ยืนยันตัวตนไม่ได้/model ใช้ไม่ได้/timeout หรือคำตอบไม่ตรง พร้อมคำแนะนำและ sanitized logs เท่าที่ runtime ส่งมา
- Configuration changed / retest: ผลเก่าเกิดก่อนแก้ model/runtime/skills/environment ต้องทดสอบใหม่ ผลทุกครั้งเป็นหลักฐาน ณ เวลาที่ระบุ ไม่ใช่การรับรองว่าบัญชีจะใช้ได้ตลอดไป

Test ส่งเฉพาะคำสั่งตรวจการตอบกลับสั้น ไม่ส่งบริบทบริษัท/โปรเจกต์/บทสนทนา และใช้ workspace ว่างแยก ไม่สร้างงานหรือข้อความแชต ไม่เปลี่ยน login หรือคอนฟิกให้เอง Provider อาจคิดค่าบริการ จึงเรียกจริงเฉพาะตอนกดปุ่ม ไม่มี auto-test ตอนเปิดหน้า API ตั้ง timeout 20 วินาทีและ output budget 256 tokens; CLI deadline 30 วินาที (รวมเวลาเริ่ม provider)

หลังแก้ `.env` ต้อง restart แอปก่อนทดสอบ CLI login ให้ทำใน terminal ของ provider นั้น การทดสอบผ่านแปลว่าเรียก model ได้จริง แต่ยังไม่ใช่หลักฐานว่าทุก skill/workflow ทำงานถูกต้อง ถ้าแอปปิดระหว่างทดสอบจะเป็น Interrupted และไม่เรียกโมเดลซ้ำอัตโนมัติ ผลทดสอบบันทึกใน Firebird พร้อม audit

API: `GET /api/agent-diagnostics` และ `POST /api/agents/{id}/diagnostics` (ต้องเป็น human operator) การเรียกซ้อน agent เดียวกันที่กำลังทดสอบตอบ 409


## Runtime adapter ต้องพร้อมก่อน Register agent

ลำดับใหม่คือ **Configuration → Runtime adapter setup → Save → Verify → Available → Register agent** การพบ CLI หรือมี API key อย่างเดียวไม่ทำให้เลือกใช้ได้

1. เตรียม CLI/login หรือ API credentials/endpoint บนเครื่องก่อน ตาม `.env` และคำแนะนำของ provider
2. เปิด Configuration เลือก adapter ใส่ **Verification model** ที่บัญชีใช้ได้ ติ๊ก Enable แล้วกด **Save <runtime> setup**
3. กด **Verify <runtime> adapter** เป็นคำขอสั้นจริง อาจมีค่าบริการ แต่ไม่ส่งข้อมูลโปรเจกต์ เมื่อตอบกลับตรงและคอนฟิกไม่เปลี่ยนจึงเป็น **Available** การทดสอบนี้ทำได้ก่อนมี agent และยังต้องทดสอบ model ของ agent แต่ละตัวแยกถ้าใช้ model ต่างกัน
4. ไป Agent Studio → Register agent: เลือกได้เฉพาะ adapter ที่ Available ตัวที่ยังไม่ setup/disabled/test failed/executable หายจะถูกปิดตัวเลือก Backend บังคับกฎเดียวกัน ไม่สามารถข้ามด้วย API
5. ปิด adapter ได้โดยเอาติ๊ก Enable ออกแล้ว Save Agent เดิมจะยังอยู่ พร้อมคำเตือนบนทุกหน้าและบนการ์ดของตัวนั้น การอัปเดตสถานะตรวจทุกประมาณ 2.5 วินาที งาน/แชตใหม่จะถูกปฏิเสธทันทีฝั่ง server งานที่กำลังเรียก provider ตรวจซ้ำก่อนรับผล; API ที่ส่งไปแล้วอาจไม่หยุดคิดค่าบริการทันที
6. แก้ Verification model/คอนฟิก หรือเปลี่ยน provider credentials แล้วต้อง Verify ใหม่ การเปิดคืนหลัง disable ต้องผ่าน verification ใหม่เช่นกัน ไม่ใช้ผลเก่าอัตโนมัติ

หลังอัปเดตรุ่นนี้ adapter ทั้งหมดเริ่มเป็น Not configured เพื่อไม่อ้างว่าคอนฟิกเก่าผ่านแล้ว Agent เดิมและประวัติไม่ถูกลบ แต่ยังใช้รันไม่ได้จนกว่าจะ setup/verify Runtime ให้พร้อม นโยบายบริษัทและ human approval ยังบังคับเหมือนเดิม

Available เป็นผลตรวจคอนฟิกล่าสุดและการพบ executable ปัจจุบัน ไม่ใช่การรับรองว่า provider token จะไม่มีวันหมดอายุ หากเรียกจริงล้มเหลวให้ตรวจ login และ Verify อีกครั้ง ระบบไม่ยิงโมเดลตรวจ auth ซ้ำโดยอัตโนมัติขณะเปิดหน้า

API: `GET /api/runtime-adapters`, `PUT /api/runtime-adapters/{runtime}` พร้อม `{version, enabled, probe_model}`, `POST /api/runtime-adapters/{runtime}/verify` การตั้ง/verify ต้องเป็น human operator และมี audit ผลเปลี่ยนระหว่าง verify จะไม่ถูกนำกลับมาเปิดใช้งานทับค่าที่คนปิดไว้


Readiness tests ย้ายจาก Setup มาบนการ์ด Agent Studio แล้ว ไม่เรียก provider อัตโนมัติเมื่อเปิดหน้า ปุ่ม Test เป็นการเรียกจริงและอาจมีค่าบริการ Status/history/audit เดิมยังใช้ต่อได้ ผลที่คอนฟิกเปลี่ยนจะขึ้น Retest needed; ไม่มีปุ่มทดสอบกลุ่มอยู่ใน Setup อีกต่อไป


## LLM list แบบ Array ใน .env

ตั้ง `LLM_PROFILES_JSON` เป็น JSON array ใน `.env` ของ root โดยค่า environment ต้องอยู่บรรทัดเดียว ตัวอย่างที่พร้อมคัดลอกอยู่ใน `.env.example`:

```dotenv
LLM_PROFILES_JSON='[{"id":"main","label":"Main API","runtime":"api","model":"openai/your-model-id","api_key_env":"MAIN_LLM_KEY","enabled":true},{"id":"local","label":"Local model","runtime":"api","model":"openai/your-local-model","api_base":"http://127.0.0.1:11434/v1","api_key_env":"LOCAL_LLM_KEY","enabled":true}]'
MAIN_LLM_KEY=ใส่-key-บนเครื่องของคุณ
LOCAL_LLM_KEY=local
```

แต่ละ object มี `id` ไม่ซ้ำ, `label` (ไม่บังคับ), `runtime` (api/codex/claude/gemini), `model`, `enabled` และสำหรับ API มี `api_base`/`api_key_env` ได้ `api_key_env` เป็นชื่อ env variable ไม่ใช่ค่า key ห้ามใส่ `api_key` ตรงใน object; key จริงไม่ถูกส่งไป browser ไม่อนุญาตใช้ env ของ CONTROL/DATABASE/ARTIFACT เป็น provider key และ URL ต้องไม่มี user/password/query/fragment

CLI profile เช่น `{"id":"code","runtime":"codex","model":"your-codex-model-id"}` ใช้ login ของ CLI เอง ไม่ใส่ `api_base` หรือ `api_key_env` ใน CLI profile

หลังแก้ `.env` ให้ restart แอป แล้ว:

1. Configuration → Runtime adapter setup เลือก LLM profile สำหรับ Verify adapter
2. Agent Studio → Register/Edit agent เลือก runtime ที่ Available แล้วเลือก LLM profile จาก array ที่เข้ากับ runtime นั้น
3. ใช้ Readiness → Test ของ agent เพื่อทดสอบ profile/model ของตัวนั้นจริง การผ่าน adapter ด้วยโปรไฟล์หนึ่งไม่ได้พิสูจน์ว่าโปรไฟล์อื่นใช้ได้ทั้งหมด

ตัวเลือก disabled หรือขาด credential จะเลือกไม่ได้ Backend ตรวจซ้ำ ข้อมูลที่เก็บใน agent คือ `profile:<id>` และตอนเรียกจริงจะ resolve ไป model/endpoint/key ของโปรไฟล์นั้น API profile ที่ไม่มี endpoint กำหนดจะใช้ endpoint มาตรฐานของ provider ไม่สืบทอด `LLM_API_BASE` กลางโดยไม่ตั้งใจ ส่วน legacy model ID ที่บันทึกไว้เดิมและการใช้ค่ากลางยังรองรับเพื่อไม่ทำลายข้อมูลเก่า

Snapshot เก็บชื่อโปรไฟล์ model/endpoint ที่ใช้ และ hash ของคอนฟิกโดยไม่เก็บ key หากเปลี่ยน profile ของ run ที่ยังไม่จบ จะปฏิเสธ Resume และให้เริ่ม workflow ใหม่ แชตจะ reset provider binding เมื่อคำขอถัดไปใช้ profile config ใหม่ ประวัติเก่ายังอยู่

ถ้าไม่กำหนด array จะยังกรอก model แบบเดิมได้ ไม่ต้องเปลี่ยนข้อมูลเดิมทั้งหมดทันที JSON ผิดรูปแบบ/ID ซ้ำ/field ที่ไม่รองรับจะถูกปฏิเสธด้วยข้อความที่ไม่สะท้อน secret กลับมา รายการไม่เกิน 100 โปรไฟล์
