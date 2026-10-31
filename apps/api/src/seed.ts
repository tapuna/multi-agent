import { migrate, transaction } from "./db.js";
await migrate();
await transaction(async (tx) => {
  if ((await tx.all("projects", '"KEY"=?', ["RELAY"])).length) {
    console.log("Example project exists; no changes made.");
    return;
  }
  const p = await tx.insert("projects", {
    name: "Control Center",
    key: "RELAY",
    description: "Build the next generation engineering workspace.",
  });
  await tx.audit("system:seed", "project.created", {
    project_id: p.id,
    source: "opt-in sample data",
  });
  for (const [index, title] of [
    "Design the runtime adapter contract",
    "Define project memory boundaries",
    "Build task dependency validation",
  ].entries()) {
    const t = await tx.insert("tasks", {
      project_id: p.id,
      number: index + 1,
      title,
      sprint: "Sprint 01",
    });
    await tx.audit(
      "system:seed",
      "task.created",
      { source: "opt-in sample data", title },
      t.id,
    );
  }
  console.log(
    "Example project and 3 tasks created; register tested profiles in Agent Studio.",
  );
});
