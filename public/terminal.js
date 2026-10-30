(function () {
    "use strict";

    function byId(id) {
        return document.getElementById(id);
    }

    var bootScreen = byId("bootScreen");
    var bootLog = byId("bootLog");

    if (bootScreen && bootLog) {
        var bootLines = [
            "ROBCO INDUSTRIES (TM) TERMLINK PROTOCOL",
            "INITIALIZING LOCAL INTELLIGENCE LINK...",
            "MOUNTING MEMORY FILES... OK",
            "CALIBRATING PHOSPHOR DISPLAY... OK",
            "SYNCING NEURAL CACHE... OK",
            "WELCOME, VAULT DWELLER"
        ];

        var lineIndex = 0;
        var charIndex = 0;
        var currentLine = null;
        var finished = false;

        function finishBoot() {
            if (finished) return;
            finished = true;
            bootLog.textContent = bootLines.join("\n");
            window.setTimeout(function () {
                bootScreen.classList.add("finished");
                window.setTimeout(function () {
                    bootScreen.hidden = true;
                }, 225);
            }, 160);
        }

        function advanceBoot() {
            if (finished) return;

            if (lineIndex >= bootLines.length) {
                finishBoot();
                return;
            }

            if (!currentLine) {
                currentLine = document.createElement("span");
                bootLog.appendChild(currentLine);
            }

            charIndex += 1;
            currentLine.textContent = bootLines[lineIndex].slice(0, charIndex);

            if (charIndex >= bootLines[lineIndex].length) {
                lineIndex += 1;
                charIndex = 0;
                currentLine = null;
                window.setTimeout(advanceBoot, 55);
            } else {
                window.setTimeout(advanceBoot, 7 + Math.random() * 23);
            }
        }

        bootScreen.addEventListener("click", finishBoot);
        bootScreen.addEventListener("keydown", finishBoot);
        window.setTimeout(advanceBoot, 130);
    }

    var terminalClock = byId("terminalClock");

    function updateClock() {
        if (!terminalClock) return;
        var now = new Date();
        var pad = function (value) {
            return String(value).padStart(2, "0");
        };
        terminalClock.textContent =
            pad(now.getHours()) + ":" +
            pad(now.getMinutes()) + ":" +
            pad(now.getSeconds());
    }

    if (terminalClock) {
        updateClock();
        window.setInterval(updateClock, 1000);
    }

    var dialog = byId("terminalDialog");
    var dialogTitle = byId("terminalDialogTitle");
    var dialogMessage = byId("terminalDialogMessage");
    var dialogInput = byId("terminalDialogInput");
    var dialogButtons = byId("terminalDialogButtons");

    var pendingResolve = null;

    function closeDialog() {
        if (dialog) dialog.hidden = true;
        pendingResolve = null;
        if (document.activeElement && dialog && dialog.contains(document.activeElement)) {
            document.body.focus();
        }
    }

    function buildDialogButton(label, value, isPrimary) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "terminal-dialog-btn" + (isPrimary ? " primary" : "");
        button.textContent = label;
        button.addEventListener("click", function () {
            var resolve = pendingResolve;
            closeDialog();
            if (resolve) resolve(value);
        });
        return button;
    }

    function openDialog(options) {
        if (!dialog || !dialogTitle || !dialogMessage || !dialogButtons || !dialogInput) {
            return Promise.reject(new Error("Terminal dialog is unavailable"));
        }

        if (pendingResolve) {
            pendingResolve(null);
        }

        dialogTitle.textContent = options.title || "";
        dialogMessage.textContent = options.message || "";
        dialogMessage.hidden = !options.message;
        dialogInput.value = options.value || "";
        dialogInput.hidden = !options.input;
        dialogButtons.innerHTML = "";

        var buttons = options.buttons || [
            { label: "ACKNOWLEDGE", value: true, primary: true }
        ];

        buttons.forEach(function (button) {
            dialogButtons.appendChild(buildDialogButton(
                button.label,
                button.value,
                button.primary === true
            ));
        });

        dialog.hidden = false;

        return new Promise(function (resolve) {
            pendingResolve = resolve;
            if (options.input) {
                dialogInput.focus();
            } else {
                var primary = dialogButtons.querySelector(".terminal-dialog-btn.primary");
                if (primary) primary.focus();
            }
        });
    }

    window.terminalPrompt = function (title, value) {
        return openDialog({
            title: title,
            message: "",
            input: true,
            value: value || "",
            buttons: [
                { label: "ACCEPT", value: true, primary: true },
                { label: "CANCEL", value: false }
            ]
        }).then(function (accepted) {
            return accepted ? dialogInput.value : null;
        });
    };

    window.terminalConfirm = function (message, title) {
        return openDialog({
            title: title || "CONFIRM ACTION",
            message: message,
            buttons: [
                { label: "CONFIRM", value: true, primary: true },
                { label: "CANCEL", value: false }
            ]
        }).then(function (accepted) {
            return accepted === true;
        });
    };

    window.terminalAlert = function (message, title) {
        return openDialog({
            title: title || "SYSTEM NOTICE",
            message: message,
            buttons: [
                { label: "ACKNOWLEDGE", value: true, primary: true }
            ]
        });
    };

    dialogInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault();
            var value = dialogInput.value;
            var resolve = pendingResolve;
            closeDialog();
            if (resolve) resolve(value);
        } else if (event.key === "Escape") {
            event.preventDefault();
            var cancel = pendingResolve;
            closeDialog();
            if (cancel) cancel(null);
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && dialog && !dialog.hidden) {
            var cancel = pendingResolve;
            closeDialog();
            if (cancel) cancel(null);
        }
    });
})();
