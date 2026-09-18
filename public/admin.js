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