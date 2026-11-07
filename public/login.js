(async () => {
  const $ = (s) => document.querySelector(s);
  let setup = false;
  try { setup = (await (await fetch("/api/setup")).json()).needsSetup; } catch (e) {}
  if (setup) {
    $("#h").textContent = "Create the owner account";
    $("#sub").textContent = "This is the first time the ledger is opened. The owner can add staff accounts later.";
    $("#nameRow").hidden = false; $("#go").textContent = "Create account";
    $("#password").autocomplete = "new-password"; $("#password").placeholder = "At least 8 characters";
    $("#name").focus();
  } else $("#username").focus();
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#go"); btn.disabled = true; $("#err").hidden = true;
    const body = { username: $("#username").value.trim(), password: $("#password").value };
    if (setup) body.name = $("#name").value.trim();
    try {
      const r = await fetch(setup ? "/api/setup" : "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || "Couldn't sign in. Try again.");
      location.href = "/";
    } catch (err) { $("#err").textContent = err.message; $("#err").hidden = false; btn.disabled = false; }
  });
})();
