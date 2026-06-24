import {
    Generate,
    getRequestHeaders,
    saveSettingsDebounced,
    sendMessageAsUser,
} from '../../script.js';
import {
    extension_settings,
    getContext,
} from '../extensions.js';
import { escapeHtml } from '../utils.js';

const MODULE_NAME = 'ss14_bridge';
const API_ROOT = '/api/plugins/ss14-bridge';
const POLL_INTERVAL_MS = 900;

const defaults = {
    enabled: false,
    send_mode: 'confirm',
    radio_key: ';',
    max_length: 350,
    listen_speech: true,
    listen_whisper: true,
    listen_radio: true,
    listen_announcement: true,
    listeners: [],
};

let cursor = -1;
let pollTimer = null;
let processing = false;
let queue = [];
let pendingDraft = null;

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaults };
    }
    if (!Array.isArray(extension_settings[MODULE_NAME].listeners)) {
        extension_settings[MODULE_NAME].listeners = [];
    }
    return extension_settings[MODULE_NAME];
}

async function api(path, body = null) {
    const response = await fetch(`${API_ROOT}${path}`, {
        method: body === null ? 'GET' : 'POST',
        headers: getRequestHeaders(),
        body: body === null ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Bridge request failed (${response.status}).`);
    }
    return payload;
}

function setStatus(online, text = online ? 'online' : 'offline') {
    $('#roe_bridge_status')
        .text(text)
        .toggleClass('is-online', online)
        .toggleClass('is-offline', !online);
}

function log(text) {
    const time = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    $('#roe_event_log').prepend(
        `<div class="roe-log-entry"><time>${escapeHtml(time)}</time>${escapeHtml(text)}</div>`,
    );
}

function normalizeName(value) {
    return String(value || '')
        .replace(/\[.*?\]/g, '')
        .trim()
        .toLocaleLowerCase();
}

function listenerFor(message) {
    const channelEnabled = {
        speech: settings().listen_speech,
        whisper: settings().listen_whisper,
        radio: settings().listen_radio,
        announcement: settings().listen_announcement,
    }[message.channel];
    if (!channelEnabled) {
        return false;
    }
    if (message.channel === 'announcement') {
        return true;
    }
    const speaker = normalizeName(message.speaker);
    return settings().listeners.find(listener =>
        normalizeName(listener.name) === speaker && listener[message.channel]);
}

function stripBbcode(text) {
    return String(text || '').replace(/\[.*?\]/g, '');
}

function formatIncoming(message) {
    return stripBbcode(message.text);
}

function renderListeners() {
    const container = $('#roe_listener_list').empty();
    settings().listeners.forEach((listener, index) => {
        container.append(`
            <div class="roe-tag" data-index="${index}">
                <span class="roe-tag-name">${escapeHtml(listener.name)}</span>
                <button class="menu_button roe-icon-button roe-remove-listener" type="button" title="Удалить">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `);
    });
}

function addListener(name) {
    name = String(name || '').trim();
    if (!name) return;
    const cur = settings();
    if (cur.listeners.some(l => normalizeName(l.name) === normalizeName(name))) return;
    cur.listeners.push({ name, speech: true, whisper: true, radio: true });
    renderListeners();
    saveSettingsDebounced();
}

function syncSettingsFromUi() {
    const current = settings();
    current.enabled = $('#roe_enabled').prop('checked');
    current.send_mode = $('#roe_send_mode').val();
    current.radio_key = String($('#roe_radio_key').val() || ';').trim() || ';';
    current.listen_speech = $('#roe_listen_speech').prop('checked');
    current.listen_whisper = $('#roe_listen_whisper').prop('checked');
    current.listen_radio = $('#roe_listen_radio').prop('checked');
    current.listen_announcement = $('#roe_listen_announcement').prop('checked');
    current.max_length = Math.max(
        20,
        Math.min(1000, Number($('#roe_max_length').val()) || defaults.max_length),
    );
    saveSettingsDebounced();
}

function updateDraft(text, message) {
    const replyChannel = message.channel === 'announcement'
        ? 'speech'
        : message.channel;
    pendingDraft = {
        text: String(text || '').trim().slice(0, settings().max_length),
        channel: replyChannel,
        radio_key: settings().radio_key,
        source: message,
    };
    $('#roe_draft_text').val(pendingDraft.text);
    $('#roe_draft_channel').text(
        replyChannel === 'radio'
            ? `radio ${pendingDraft.radio_key}`
            : replyChannel,
    );
    $('#roe_send_draft').prop('disabled', !pendingDraft.text);
}

async function sendDraft() {
    if (!pendingDraft) {
        return;
    }
    pendingDraft.text = String($('#roe_draft_text').val() || '')
        .trim()
        .slice(0, settings().max_length);
    if (!pendingDraft.text) {
        return;
    }
    await api('/send', {
        text: pendingDraft.text,
        channel: pendingDraft.channel,
        radio_key: pendingDraft.radio_key,
    });
    log(`Отправлено в ${pendingDraft.channel}: ${pendingDraft.text}`);
    pendingDraft = null;
    $('#roe_send_draft').prop('disabled', true);
    $('#roe_draft_channel').text('отправлено');
}

async function processMessage(message, receivedAt) {
    const context = getContext();
    if (!context.characterId && !context.groupId) {
        log('Сообщение пропущено: не выбран персонаж или группа.');
        return;
    }

    log(`Принято ${message.channel}: ${stripBbcode(message.speaker)}: ${stripBbcode(message.text)}`);
    await sendMessageAsUser(formatIncoming(message), '');
    await Generate('normal', { automatic_trigger: true });

    const reply = [...context.chat]
        .reverse()
        .find(item => item && !item.is_user && !item.is_system);
    const text = String(reply?.mes || '').trim();
    if (!text) {
        log('Модель не вернула текстовый ответ.');
        return;
    }

    updateDraft(text, message);
    if (settings().send_mode === 'auto') {
        const elapsed = Date.now() - receivedAt;
        const textDelay = Math.min(Math.ceil(text.length / 8) * 1000, 10000);
        const wait = Math.max(0, textDelay - elapsed);
        if (wait > 100) {
            log(`Пауза ${Math.round(wait)}мс перед отправкой (${text.length} символов)`);
            await new Promise(r => setTimeout(r, wait));
        }
        await sendDraft();
    } else {
        log('Ответ ожидает подтверждения.');
    }
}

async function drainQueue() {
    if (processing) {
        return;
    }
    processing = true;
    try {
        while (queue.length > 0) {
            const item = queue.shift();
            await processMessage(item.message, item.receivedAt);
        }
    } catch (error) {
        console.error('[Rot of Elizium] Failed to process SS14 message.', error);
        log(`Ошибка генерации: ${error.message || error}`);
    } finally {
        processing = false;
    }
}

async function poll() {
    try {
        const payload = await api('/messages', { after_id: cursor });
        setStatus(true);
        cursor = Number.isSafeInteger(payload.chat_cursor)
            ? payload.chat_cursor
            : cursor;
        if (!settings().enabled) {
            return;
        }

        const raw = payload.chat_messages || [];
        if (raw.length > 0) {
            log(`Получено ${raw.length} сообщений из игры`);
            raw.forEach(m => log(`  [${m.channel}] ${stripBbcode(m.speaker)}: ${stripBbcode(m.text).slice(0, 60)}`));
        }
        const accepted = raw.filter(listenerFor);
        if (accepted.length === 0 && raw.length > 0) {
            log(`Ни одно из ${raw.length} сообщений не прошло фильтр`);
        }
        const now = Date.now();
        accepted.forEach(m => queue.push({ message: m, receivedAt: now }));
        void drainQueue();
    } catch (error) {
        setStatus(false);
    }
}

function bindUi() {
    const current = settings();
    $('#roe_enabled').prop('checked', current.enabled);
    $('#roe_send_mode').val(current.send_mode);
    $('#roe_radio_key').val(current.radio_key);
    $('#roe_listen_speech').prop('checked', current.listen_speech);
    $('#roe_listen_whisper').prop('checked', current.listen_whisper);
    $('#roe_listen_radio').prop('checked', current.listen_radio);
    $('#roe_listen_announcement').prop('checked', current.listen_announcement);
    $('#roe_max_length').val(current.max_length);
    renderListeners();

    $('.roe-bridge').on('change input', 'input, select', syncSettingsFromUi);
    const doAdd = () => {
        const input = $('#roe_listener_input');
        addListener(input.val());
        input.val('').trigger('focus');
    };
    $('#roe_add_listener').on('click', doAdd);
    $('#roe_listener_input').on('keydown', e => { if (e.key === 'Enter') doAdd(); });
    $('#roe_listener_list').on('click', '.roe-remove-listener', function () {
        const index = Number($(this).closest('.roe-tag').data('index'));
        settings().listeners.splice(index, 1);
        renderListeners();
        saveSettingsDebounced();
    });
    $('#roe_send_draft').on('click', async () => {
        try {
            await sendDraft();
        } catch (error) {
            log(`Ошибка отправки: ${error.message || error}`);
        }
    });
    $('#roe_clear_log').on('click', () => $('#roe_event_log').empty());
    $('#roe_inject_bridge').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true);
        $('#roe_inject_status').text('поиск клиента');
        try {
            const result = await api('/inject', { timeout: 45 });
            $('#roe_inject_status').text('подключён');
            setStatus(true);
            cursor = -1;
            log(result.already_running
                ? 'Bridge уже был подключён.'
                : 'Bridge успешно инъецирован в SS14.Loader.');
        } catch (error) {
            $('#roe_inject_status').text('ошибка');
            log(`Ошибка инъекции: ${error.message || error}`);
        } finally {
            button.prop('disabled', false);
        }
    });
}

export async function init() {
    settings();
    bindUi();
    await poll();
    pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
    window.addEventListener('beforeunload', () => window.clearInterval(pollTimer), {
        once: true,
    });
}
