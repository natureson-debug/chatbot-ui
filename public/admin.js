async function loadThemeSettings() {
    try {
        const response = await fetch("/api/settings", {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const settings = await response.json();
        document.body.dataset.theme = settings.theme === "light" ? "light" : "dark";
    } catch (error) {
        console.error("Failed to load user theme:", error);
        document.body.dataset.theme = "dark";
    }
}

loadThemeSettings();

function closeAllUserMenus() {
    document.querySelectorAll(".user-actions-menu").forEach((menu) => {
        menu.hidden = true;
        const wrap = menu.closest(".user-actions");
        const toggle = wrap?.querySelector(".user-menu-toggle");
        if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
}

document.addEventListener("click", closeAllUserMenus);

async function loadUsers() {
    const status = document.getElementById("usersStatus");
    const table = document.getElementById("usersTable");
    const tbody = document.getElementById("usersTableBody");

    try {
        const response = await fetch("/api/admin/users", {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("Unable to load users");
        }

        const users = await response.json();

        tbody.replaceChildren();

        const usersCount = document.getElementById("usersCount");
        if (usersCount) {
            usersCount.textContent = `${users.length} user${users.length === 1 ? "" : "s"}`;
        }

        for (const user of users) {
            const row = document.createElement("tr");
            const username = document.createElement("td");
            const role = document.createElement("td");

            username.textContent = user.username;
            role.textContent = user.is_admin === 1 ? "Administrator" : "User";

            const actions = document.createElement("td");
            actions.className = "actions-cell";

            const actionWrap = document.createElement("div");
            actionWrap.className = "user-actions";

            const menuToggle = document.createElement("button");
            menuToggle.type = "button";
            menuToggle.className = "user-menu-toggle";
            menuToggle.textContent = "⋮";
            menuToggle.title = "User actions";
            menuToggle.setAttribute("aria-label", `Actions for ${user.username}`);
            menuToggle.setAttribute("aria-haspopup", "menu");
            menuToggle.setAttribute("aria-expanded", "false");

            const menu = document.createElement("div");
            menu.className = "user-actions-menu";
            menu.hidden = true;
            menu.setAttribute("role", "menu");

            const resetButton = document.createElement("button");
            resetButton.type = "button";
            resetButton.textContent = "Reset Password";
            resetButton.className = "user-menu-item reset-btn";
            resetButton.setAttribute("role", "menuitem");
            resetButton.dataset.userId = user.id;

            resetButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    closeAllUserMenus();
    if (resetButton.disabled) return;

    const newPassword = typeof terminalPrompt === "function"
        ? await terminalPrompt(`Enter a new password for "${user.username}" (minimum 12 characters)`, "")
        : prompt(`Enter a new password for "${user.username}" (at least 12 characters):`);

    if (newPassword === null) return;

    if (newPassword.length < 12) {
        if (typeof terminalAlert === "function") {
            await terminalAlert("Password must contain at least 12 characters.", "INVALID INPUT");
        } else {
            alert("Password must contain at least 12 characters.");
        }
        return;
    }

    const confirmedReset = typeof terminalConfirm === "function"
        ? await terminalConfirm(`Reset the password for "${user.username}"? This will sign out all of their active sessions.`, "RESET PASSWORD")
        : confirm(`Reset the password for "${user.username}"? This will sign out all of their active sessions.`);

    if (!confirmedReset) {
        return;
    }

    resetButton.disabled = true;

    try {
        const response = await fetch("/api/admin/reset-password", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userId: user.id,
                newPassword
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Password reset failed");
        }

        if (typeof terminalAlert === "function") {
            await terminalAlert(`Password reset successfully for "${user.username}".`, "RESET COMPLETE");
        } else {
            alert(`Password reset successfully for "${user.username}".`);
        }
    } catch (error) {
        if (typeof terminalAlert === "function") {
            await terminalAlert(error.message, "LINK ERROR");
        } else {
            alert(error.message);
        }
    } finally {
        resetButton.disabled = false;
    }
});

            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.textContent = "Delete User";
            deleteButton.className = "user-menu-item delete-btn";
            deleteButton.setAttribute("role", "menuitem");
            deleteButton.dataset.userId = user.id;
            deleteButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    closeAllUserMenus();
    if (deleteButton.disabled) return;

    const message =
        `Permanently delete "${user.username}"?\n\n` +
        "This will also delete their chats and messages " +
        "and sign them out of all active sessions.\n\n" +
        "This action cannot be undone.";

    const confirmed = typeof terminalConfirm === "function"
        ? await terminalConfirm(message, "DELETE USER")
        : confirm(message);

    if (!confirmed) return;

    deleteButton.disabled = true;

    try {
        const response = await fetch(
            `/api/admin/users/${encodeURIComponent(user.id)}`,
            {
                method: "DELETE",
                credentials: "same-origin"
            }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Unable to delete user");
        }

        if (typeof terminalAlert === "function") {
            await terminalAlert(`User "${user.username}" deleted successfully.`, "DELETE COMPLETE");
        } else {
            alert(`User "${user.username}" deleted successfully.`);
        }
        await loadUsers();
    } catch (error) {
        if (typeof terminalAlert === "function") {
            await terminalAlert(error.message, "LINK ERROR");
        } else {
            alert(error.message);
        }
    } finally {
        deleteButton.disabled = false;
    }
});

            menu.append(resetButton, deleteButton);
            actionWrap.append(menuToggle, menu);
            actions.append(actionWrap);

            menuToggle.addEventListener("click", (event) => {
                event.stopPropagation();
                const wasOpen = !menu.hidden;
                closeAllUserMenus();
                if (!wasOpen) {
                    menu.hidden = false;
                    menuToggle.setAttribute("aria-expanded", "true");
                }
            });

            row.append(username, role, actions);
            tbody.append(row);
        }

        status.hidden = true;
        table.hidden = false;
    } catch (error) {
        status.textContent = error.message;
        table.hidden = true;
    }
}

loadUsers();

const createUserForm = document.getElementById("createUserForm");
const createUserStatus = document.getElementById("createUserStatus");

createUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const usernameInput = document.getElementById("newUsername");
    const passwordInput = document.getElementById("newPassword");
    const submitButton = createUserForm.querySelector('button[type="submit"]');

    createUserStatus.hidden = true;
    submitButton.disabled = true;

    try {
        const response = await fetch("/api/admin/users", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
    username: usernameInput.value,
    password: passwordInput.value,
    role: document.getElementById("newUserRole").value
})
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Unable to create user");
        }

        createUserStatus.textContent = `User "${result.username}" created successfully.`;
        createUserStatus.hidden = false;

        createUserForm.reset();
        await loadUsers();

    } catch (error) {
        createUserStatus.textContent = error.message;
        createUserStatus.hidden = false;
    } finally {
        passwordInput.value = "";
        submitButton.disabled = false;
    }
});

const aiGpuLayers = document.getElementById("aiGpuLayers");
const aiDevice = document.getElementById("aiDevice");
const aiVerbosity = document.getElementById("aiVerbosity");
const aiParallel = document.getElementById("aiParallel");
const aiContextSize = document.getElementById("aiContextSize");
const aiContextPerSlot = document.getElementById("aiContextPerSlot");
const aiServerStatus = document.getElementById("aiServerStatus");
const aiServerStatusIndicator = document.getElementById("aiServerStatusIndicator");
const aiMetrics = document.getElementById("aiMetrics");

function updateContextPerSlot() {
    const parallel = Number(aiParallel.value);
    const totalContext = Number(aiContextSize.value);

    if (parallel > 0 && totalContext > 0) {
        aiContextPerSlot.value = Math.floor(totalContext / parallel);
    } else {
        aiContextPerSlot.value = "";
    }
}

aiParallel.addEventListener("input", updateContextPerSlot);
aiContextSize.addEventListener("input", updateContextPerSlot);

updateContextPerSlot();

const aiModel = document.getElementById("aiModel");

function setupAdminTabs() {
    const tabs = Array.from(document.querySelectorAll(".admin-tab"));
    const panels = Array.from(document.querySelectorAll("[data-admin-tabpanel]"));

    function activate(tabName) {
        tabs.forEach((tab) => {
            const active = tab.dataset.tab === tabName;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-selected", String(active));
        });

        panels.forEach((panel) => {
            const active = panel.id === `tab-${tabName}`;
            panel.hidden = !active;
        });
    }

    tabs.forEach((tab) => {
        tab.addEventListener("click", () => activate(tab.dataset.tab));
    });

    const initial = tabs.find((tab) => tab.classList.contains("active"));
    if (initial) activate(initial.dataset.tab);
}

function closeAllTerminalSelects() {
    document.querySelectorAll(".terminal-select").forEach((wrapper) => {
        wrapper.classList.remove("open");
        const trigger = wrapper.querySelector(".terminal-select-trigger");
        const menu = wrapper.querySelector(".terminal-select-menu");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
}

document.addEventListener("click", closeAllTerminalSelects);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllTerminalSelects();
});

function enhanceSelect(select) {
    if (!select || select.dataset.terminalSelect === "1") return select;
    select.dataset.terminalSelect = "1";

    const wrapper = document.createElement("div");
    wrapper.className = "terminal-select";
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "terminal-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "terminal-select-label";

    const caret = document.createElement("span");
    caret.className = "terminal-select-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";

    trigger.append(label, caret);

    const menu = document.createElement("div");
    menu.className = "terminal-select-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");

    wrapper.append(trigger, menu);

    function selectedOption() {
        return select.options[select.selectedIndex] || null;
    }

    function syncOptions() {
        menu.replaceChildren();

        Array.from(select.options).forEach((option) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "terminal-select-option";
            item.dataset.value = option.value;
            item.textContent = option.textContent;
            item.disabled = option.disabled;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(option.selected));

            if (option.selected) item.classList.add("selected");

            item.addEventListener("click", (event) => {
                event.stopPropagation();
                select.value = option.value;
                syncTrigger();
                closeAllTerminalSelects();
                select.dispatchEvent(new Event("change", { bubbles: true }));
            });

            menu.appendChild(item);
        });
    }

    function syncTrigger() {
        const option = selectedOption();
        label.textContent = option ? option.textContent : "Select";
        trigger.title = option ? option.textContent : "";
        trigger.disabled = select.disabled;
        trigger.setAttribute("aria-disabled", String(select.disabled));

        Array.from(menu.children).forEach((item) => {
            const selected = item.dataset.value === select.value;
            item.classList.toggle("selected", selected);
            item.setAttribute("aria-selected", String(selected));
        });
    }

    trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = !menu.hidden;
        closeAllTerminalSelects();
        if (!open) {
            menu.hidden = false;
            wrapper.classList.add("open");
            trigger.setAttribute("aria-expanded", "true");
        }
    });

    select.addEventListener("change", syncTrigger);

    const selectForm = select.form || select.closest("form");
    if (selectForm) {
        selectForm.addEventListener("reset", () => {
            window.setTimeout(() => {
                syncOptions();
                syncTrigger();
            }, 0);
        });
    }

    syncOptions();
    syncTrigger();

    select.terminalSelect = {
        sync() {
            syncOptions();
            syncTrigger();
        }
    };

    return select;
}

function syncTerminalSelect(select) {
    if (select && typeof select.terminalSelect?.sync === "function") {
        select.terminalSelect.sync();
    }
}

function enhanceAdminSelects() {
    ["aiModel", "aiDevice", "newUserRole", "monitorRefreshRate"].forEach((id) => {
        enhanceSelect(document.getElementById(id));
    });
}

enhanceAdminSelects();
setupAdminTabs();

async function loadAiModels() {
    try {
        const response = await fetch("/api/admin/ai/models", {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const models = await response.json();

        aiModel.innerHTML = "";

        for (const model of models) {
            const option = document.createElement("option");
            option.value = model;
            option.textContent = model;
            aiModel.appendChild(option);
        }

    } catch (error) {
        console.error("Failed to load AI models:", error);

        aiModel.innerHTML = "";

        const option = document.createElement("option");
        option.textContent = "Failed to load models";
        option.disabled = true;
        option.selected = true;

        aiModel.appendChild(option);
    }

    syncTerminalSelect(aiModel);
}

async function loadAiServerStatus() {
    try {
        const response = await fetch("/api/admin/ai/status", {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const status = await response.json();
        document.getElementById("aiModelState").textContent =
            `Configured model: ${status.configuredModel || "Not available"}.`;

        if (status.running) {
    aiServerStatus.textContent = "Running";
    aiServerStatusIndicator.className =
        "ai-status-indicator running";
} else {
    aiServerStatus.textContent = "Unavailable";
    aiServerStatusIndicator.className =
        "ai-status-indicator unavailable";
}

    } catch (error) {
        document.getElementById("aiModelState").textContent = "Configured model information is unavailable.";
        console.error("Failed to load AI server status:", error);
        aiServerStatus.textContent = "Unavailable";
        aiServerStatusIndicator.className = "ai-status-indicator unavailable";
    }
}

async function loadAiConfig() {
    try {
        const response = await fetch("/api/admin/ai/config", {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const config = await response.json();

        aiModel.value = config.model;
        aiParallel.value = config.parallel;
        aiContextSize.value = config.contextSize;
        aiGpuLayers.value = config.gpuLayers ?? 37;
        aiDevice.value = config.device ?? "CUDA0";
        aiVerbosity.value = config.verbosity ?? 4;
        aiMetrics.checked = config.metrics === true;

        updateContextPerSlot();

    } catch (error) {
        console.error("Failed to load AI configuration:", error);
    }
}

async function initializeAiConfig() {
    await loadAiModels();
    await loadAiConfig();
    syncTerminalSelect(aiModel);
    syncTerminalSelect(aiDevice);
    await loadAiServerStatus();
}

initializeAiConfig();

const saveAiConfig = document.getElementById("saveAiConfig");
const aiConfigStatus = document.getElementById("aiConfigStatus");


saveAiConfig.addEventListener("click", async () => {
    const config = {
        model: aiModel.value,
        parallel: Number(aiParallel.value),
        contextSize: Number(aiContextSize.value),
        gpuLayers: aiGpuLayers.value === "" ? null : Number(aiGpuLayers.value),
        device: aiDevice.value,
        verbosity: aiVerbosity.value === "" ? null : Number(aiVerbosity.value),
        metrics: aiMetrics.checked
    };

    saveAiConfig.disabled = true;
    aiConfigStatus.hidden = false;
    aiConfigStatus.textContent = "Saving configuration...";

    try {
        const response = await fetch("/api/admin/ai/config", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(config)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        const confirmed = result.config;
        const numericSettings = ["parallel", "contextSize", "gpuLayers", "verbosity"];
        const submittedFieldCount = Object.keys(config).length;
        const matches = confirmed && typeof confirmed === "object" && !Array.isArray(confirmed) &&
            Object.keys(config).every(key => Object.hasOwn(confirmed, key) &&
                confirmed[key] === config[key]) &&
            numericSettings.every(key => Number.isSafeInteger(config[key]) &&
                Number.isSafeInteger(confirmed[key]));
        if (!matches) {
            throw new Error(`Persistence mismatch: the server did not confirm all ${submittedFieldCount} submitted settings. Reload configuration before trying again.`);
        }

        aiConfigStatus.textContent = "Configuration saved. Changes apply the next time llama.cpp starts. Restart required; run Restart-ChatbotAI from an elevated PowerShell to apply them.";
        await loadAiServerStatus();

    } catch (error) {
        console.error("Failed to save AI configuration:", error);
        aiConfigStatus.textContent =
            `Failed to save configuration: ${error.message}`;
    } finally {
        saveAiConfig.disabled = false;
    }
});
