'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');

function fixture({ fail = false, notificationThrows = false, confirmation = true } = {}) {
    const notices = [], alerts = [];
    const chat = { title: 'original', messages: [] };
    let deleteClick;
    const context = {
        chatStore: { activeChatId: 'chat-id', chats: { 'chat-id': chat } },
        contextMenuChatId: 'chat-id',
        sessionEpoch: 0,
        loginScreen: { hidden: true },
        chat: { innerHTML: '' },
        terminalPrompt: async () => 'renamed',
        terminalConfirm: async () => confirmation,
        terminalAlert: async message => alerts.push(message),
        ChatbotNotifications: { show(notice) { if (notificationThrows) throw Error('private'); notices.push(notice); } },
        console: { error() {}, warn() {} },
        fetch: async () => ({ ok: !fail, status: 500 }),
        updateActiveChatTitle() {}, renderChatList() {}, restoreChat() {}, invalidateGeneration() {},
        closeChatContextMenu() {},
        deleteChatAction: { addEventListener(_type, callback) { deleteClick = callback; } }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('async function notifyChatOperation('), source.indexOf('attachmentInput.addEventListener(')), context);
    vm.runInContext(source.slice(source.indexOf('async function renameChat('), source.indexOf('function renderChatList()')), context);
    vm.runInContext(source.slice(source.indexOf('deleteChatAction.addEventListener('), source.indexOf('\ndocument.addEventListener("click", (event) => {', source.indexOf('deleteChatAction.addEventListener('))), context);
    return { context, chat, notices, alerts, deleteChat: () => deleteClick() };
}

test('rename reports one success or failure without publishing a failed title', async () => {
    for (const fail of [false, true]) {
        const ui = fixture({ fail });
        await ui.context.renameChat('chat-id');
        assert.equal(ui.notices.length, 1);
        assert.equal(ui.notices[0].severity, fail ? 'error' : 'success');
        assert.equal(ui.chat.title, fail ? 'original' : 'renamed');
        assert.deepEqual(ui.alerts, []);
    }
});

test('delete requires confirmation and reports one outcome', async () => {
    for (const fail of [false, true]) {
        const ui = fixture({ fail });
        await ui.deleteChat();
        assert.equal(ui.notices.length, 1);
        assert.equal(ui.notices[0].severity, fail ? 'error' : 'success');
        assert.equal(Boolean(ui.context.chatStore.chats['chat-id']), fail);
        assert.deepEqual(ui.alerts, []);
    }
    const cancelled = fixture({ confirmation: false });
    await cancelled.deleteChat();
    assert.equal(cancelled.notices.length, 0);
    assert.ok(cancelled.context.chatStore.chats['chat-id']);
});

test('legacy error alert remains available when notification rendering fails', async () => {
    const ui = fixture({ fail: true, notificationThrows: true });
    await ui.context.renameChat('chat-id');
    assert.equal(ui.notices.length, 0);
    assert.deepEqual(ui.alerts, ['Could not rename the chat. Please try again.']);
});

test('clear retains confirmation and reports success or an uncertain outcome once', async () => {
    for (const fail of [false, true]) {
        const notices = [], target = { title: 'original', messages: ['message'] };
        let reconciled = 0;
        const context = {
            sessionEpoch: 0, loginScreen: { hidden: true },
            chatStore: { activeChatId: 'id', chats: { id: target } },
            terminalConfirm: async () => true,
            ChatbotNotifications: { show: notice => notices.push(notice) },
            console: { error() {}, warn() {} },
            invalidateGeneration() {}, restoreChat() {}, renderChatList() {},
            requireServerRevision: value => value,
            reconcileConversation: async () => { reconciled++; },
            fetch: async () => ({ ok: !fail, status: 500, json: async () => ({ revision: 1 }) })
        };
        vm.createContext(context);
        vm.runInContext(source.slice(source.indexOf('async function notifyChatOperation('), source.indexOf('attachmentInput.addEventListener(')), context);
        vm.runInContext(source.slice(source.indexOf('async function clearConversation('), source.indexOf('deleteChatButton.addEventListener(')), context);
        await context.clearConversation('id');
        assert.equal(notices.length, 1);
        assert.equal(notices[0].severity, fail ? 'warning' : 'success');
        assert.equal(reconciled, fail ? 1 : 0);
        if (!fail) assert.equal(target.messages.length, 0);
    }
});
