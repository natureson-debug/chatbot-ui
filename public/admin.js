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
            const resetButton = document.createElement("button");

            resetButton.type = "button";
            resetButton.textContent = "Reset Password";
            resetButton.className = "action-btn reset-btn";
            resetButton.dataset.userId = user.id;

            resetButton.addEventListener("click", async () => {
    const newPassword = prompt(
        `Enter a new password for "${user.username}" (at least 12 characters):`
    );

    if (newPassword === null) return;

    if (newPassword.length < 12) {
        alert("Password must contain at least 12 characters.");
        return;
    }

    if (!confirm(`Reset the password for "${user.username}"? This will sign out all of their active sessions.`)) {
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

        alert(`Password reset successfully for "${user.username}".`);
    } catch (error) {
        alert(error.message);
    } finally {
        resetButton.disabled = false;
    }
});

            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.textContent = "Delete User";
            deleteButton.className = "action-btn delete-btn";
            deleteButton.dataset.userId = user.id;
            deleteButton.addEventListener("click", async () => {
    const confirmed = confirm(
        `Permanently delete "${user.username}"?\n\n` +
        "This will also delete their chats and messages " +
        "and sign them out of all active sessions.\n\n" +
        "This action cannot be undone."
    );

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

        alert(`User "${user.username}" deleted successfully.`);
        await loadUsers();
    } catch (error) {
        alert(error.message);
    } finally {
        deleteButton.disabled = false;
    }
});
actions.append(resetButton, deleteButton);
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

const aiParallel = document.getElementById("aiParallel");
const aiContextSize = document.getElementById("aiContextSize");
const aiContextPerSlot = document.getElementById("aiContextPerSlot");
const aiServerStatus = document.getElementById("aiServerStatus");
const aiServerStatusIndicator = document.getElementById("aiServerStatusIndicator");

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
}

async function waitForAiServer(previousPid) {
    const maxAttempts = 30;
    const delayMs = 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await fetch("/api/admin/ai/status", {
                cache: "no-store"
            });

            if (response.ok) {
                const status = await response.json();

                if (
                    status.running &&
                    status.pid &&
                    status.pid !== previousPid
                ) {
                    return true;
                }
            }
        } catch (error) {
            // Temporary failure is expected while llama.cpp restarts.
        }

        await new Promise(resolve =>
            setTimeout(resolve, delayMs)
        );
    }

    return false;
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

        updateContextPerSlot();

    } catch (error) {
        console.error("Failed to load AI configuration:", error);
    }
}

async function initializeAiConfig() {
    await loadAiModels();
    await loadAiConfig();
    await loadAiServerStatus();
}

initializeAiConfig();

const saveAiConfig = document.getElementById("saveAiConfig");
const aiConfigStatus = document.getElementById("aiConfigStatus");

const restartAiServer = document.getElementById("restartAiServer");

saveAiConfig.addEventListener("click", async () => {
    const config = {
        model: aiModel.value,
        parallel: Number(aiParallel.value),
        contextSize: Number(aiContextSize.value)
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

        aiConfigStatus.textContent = "Configuration saved successfully.";

    } catch (error) {
        console.error("Failed to save AI configuration:", error);
        aiConfigStatus.textContent =
            `Failed to save configuration: ${error.message}`;
    } finally {
        saveAiConfig.disabled = false;
    }
});

restartAiServer.addEventListener("click", async () => {
    let previousPid = null;

try {
    const statusResponse = await fetch("/api/admin/ai/status", {
        cache: "no-store"
    });

    if (statusResponse.ok) {
        const currentStatus = await statusResponse.json();
        previousPid = currentStatus.pid;
    }
} catch (error) {
    console.error("Failed to read current AI server PID:", error);
}
    aiServerStatus.textContent = "Restarting...";
    aiServerStatusIndicator.className = "ai-status-indicator restarting";
    restartAiServer.disabled = true;
    aiConfigStatus.hidden = false;
    aiConfigStatus.textContent = "Restarting AI server...";

    try {
        const response = await fetch("/api/admin/ai/restart", {
            method: "POST"
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        aiConfigStatus.textContent = "Waiting for AI server...";

const running = await waitForAiServer(previousPid);

if (running) {
    aiServerStatus.textContent = "Running";
    aiServerStatusIndicator.className =
        "ai-status-indicator running";

    aiConfigStatus.textContent =
        "AI server restarted successfully.";
} else {
    aiServerStatus.textContent = "Unavailable";
    aiServerStatusIndicator.className =
        "ai-status-indicator unavailable";

    aiConfigStatus.textContent =
        "AI server did not become available.";
}

    } catch (error) {
        console.error("Failed to restart AI server:", error);

        aiConfigStatus.textContent =
            `Failed to restart AI server: ${error.message}`;
    } finally {
        restartAiServer.disabled = false;
    }
});