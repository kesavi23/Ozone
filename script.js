let currentMonth = new Date().getMonth() + 1;
let currentYear = new Date().getFullYear();
let currentUser = null;

// Init
document.addEventListener("DOMContentLoaded", async () => {
    // Always start at the login page. A token saved from a previous visit
    // should not silently log the user back in — only submitting email +
    // password via doLogin() should take them into the app.
    localStorage.removeItem('token');
    await refreshSetupStatus();
});

// === SETUP STATUS (controls whether the "create admin" link is shown) ===
async function refreshSetupStatus() {
    try {
        const res = await fetch('/api/setup-status');
        const data = await res.json();
        document.getElementById('firstTimeSetupLink').style.display = data.initialized ? 'none' : 'block';
        document.getElementById('noSelfSignupHint').style.display = data.initialized ? 'block' : 'none';
    } catch (e) {
        // If the check fails, default to hiding self-signup (safer default).
        document.getElementById('firstTimeSetupLink').style.display = 'none';
        document.getElementById('noSelfSignupHint').style.display = 'block';
    }
}

// === AUTH ===
function toggleAuth(type) {
    document.getElementById('loginForm').style.display = type === 'login' ? 'block' : 'none';
    document.getElementById('registerForm').style.display = type === 'register' ? 'block' : 'none';
    document.getElementById('forgotForm').style.display = type === 'forgot' ? 'block' : 'none';

    if (type === 'register') {
        document.getElementById('loginTitle').innerText = 'Create Admin Account';
        document.getElementById('loginSubtitle').innerText = 'Setup your organization\'s first admin account.';
    } else if (type === 'forgot') {
        document.getElementById('loginTitle').innerText = 'Reset Password';
        document.getElementById('loginSubtitle').innerText = 'Answer your security question to set a new password.';
        // Always land back on step 1 when the form is opened.
        document.getElementById('forgotStep1').style.display = 'block';
        document.getElementById('forgotStep2').style.display = 'none';
        document.getElementById('forgotEmail').value = '';
        document.getElementById('forgotAnswer').value = '';
        document.getElementById('forgotNewPassword').value = '';
        document.getElementById('forgotConfirmPassword').value = '';
    } else {
        document.getElementById('loginTitle').innerText = 'Welcome Back';
        document.getElementById('loginSubtitle').innerText = 'Sign in to access your attendance portal.';
    }
    document.getElementById('authMsg').innerText = '';
}

async function doLogin() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
        const msg = document.getElementById('authMsg');
        msg.className = 'error-msg';
        msg.innerText = data.error;
        return;
    }
    localStorage.setItem('token', data.token);
    showApp();
    loadInitialData();
}

async function doRegister() {
    const name = document.getElementById('regName').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;
    const company = document.getElementById('regCompany').value;
    const security_question = document.getElementById('regSecQuestion').value;
    const security_answer = document.getElementById('regSecAnswer').value;

    const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, company, security_question, security_answer })
    });
    const data = await res.json();
    const msg = document.getElementById('authMsg');
    if (!res.ok) {
        msg.className = 'error-msg';
        msg.innerText = data.error;
        return;
    }
    msg.className = 'success-msg';
    msg.innerText = "Admin account created successfully. Please sign in.";
    toggleAuth('login');
    refreshSetupStatus();
}

// === FORGOT PASSWORD (self-service via security question) ===
async function findForgotAccount() {
    const email = document.getElementById('forgotEmail').value;
    const msg = document.getElementById('authMsg');
    msg.innerText = '';

    const res = await fetch('/api/forgot-password/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) {
        msg.className = 'error-msg';
        msg.innerText = data.error;
        return;
    }
    document.getElementById('forgotQuestionText').innerText = data.question;
    document.getElementById('forgotStep1').style.display = 'none';
    document.getElementById('forgotStep2').style.display = 'block';
}

async function submitPasswordReset() {
    const email = document.getElementById('forgotEmail').value;
    const answer = document.getElementById('forgotAnswer').value;
    const newPassword = document.getElementById('forgotNewPassword').value;
    const confirmPassword = document.getElementById('forgotConfirmPassword').value;
    const msg = document.getElementById('authMsg');

    if (newPassword !== confirmPassword) {
        msg.className = 'error-msg';
        msg.innerText = "Those passwords don't match.";
        return;
    }

    const res = await fetch('/api/forgot-password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, answer, new_password: newPassword })
    });
    const data = await res.json();
    if (!res.ok) {
        msg.className = 'error-msg';
        msg.innerText = data.error;
        return;
    }
    toggleAuth('login');
    msg.className = 'success-msg';
    msg.innerText = "Password reset — please sign in with your new password.";
}

function logout() {
    localStorage.removeItem('token');
    if (notifPollInterval) { clearInterval(notifPollInterval); notifPollInterval = null; }
    document.getElementById('app').classList.remove('active');
    document.getElementById('loginPage').style.display = 'flex';
    refreshSetupStatus();
}

function showApp() {
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('app').classList.add('active');
}

function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('token')
    };
}

// === NOTIFICATIONS ===
// Notifications are derived server-side from current data (pending leaves,
// break overages, etc.) — there's no persistent "read" flag on the server,
// so dismissal is tracked client-side. Once dismissed, an item stays hidden
// until its underlying id changes (e.g. a new day's attendance record, or
// the leave getting a fresh decision), at which point it's a new alert.
const NOTIF_DISMISSED_KEY = 'notif_dismissed_v1';
const NOTIF_ICONS = {
    leave_pending: '🗓️',
    break_exceeded: '⏱️',
    past_required_out: '🚪',
    leave_decided: '📩'
};
let currentNotifications = [];
let notifPollInterval = null;

function getDismissedNotifIds() {
    try { return JSON.parse(localStorage.getItem(NOTIF_DISMISSED_KEY)) || []; } catch { return []; }
}
function dismissNotifId(id) {
    const ids = getDismissedNotifIds();
    if (!ids.includes(id)) {
        ids.push(id);
        localStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify(ids));
    }
}

async function loadNotifications() {
    try {
        const res = await fetch('/api/notifications', { headers: getHeaders() });
        if (!res.ok) return;
        const all = await res.json();
        const dismissed = new Set(getDismissedNotifIds());
        currentNotifications = all.filter(n => !dismissed.has(n.id));
        renderNotifications();
    } catch (e) {
        // Notifications are a non-critical enhancement — fail silently.
    }
}

function renderNotifications() {
    const dot = document.getElementById('notifDot');
    const list = document.getElementById('notifList');
    const clearBtn = document.getElementById('notifClearBtn');
    if (!dot || !list) return;

    dot.style.display = currentNotifications.length ? 'block' : 'none';
    if (clearBtn) clearBtn.style.display = currentNotifications.length ? 'inline' : 'none';

    if (currentNotifications.length === 0) {
        list.innerHTML = '<p class="notif-empty">No new notifications.</p>';
        return;
    }

    list.innerHTML = currentNotifications.map(n => `
        <div class="notif-item" onclick="handleNotifClick('${n.id}', '${n.page || ''}')">
            <span class="notif-item-icon">${NOTIF_ICONS[n.type] || '🔔'}</span>
            <div class="notif-item-body">
                <div class="notif-item-text">${escapeHtml(n.text)}</div>
                <div class="notif-item-time">${n.time || ''}</div>
            </div>
            <button class="notif-item-dismiss" onclick="dismissNotification(event, '${n.id}')">✕</button>
        </div>
    `).join('');
}

function handleNotifClick(id, page) {
    closeNotifDropdown();
    if (page) navTo(page);
}

function dismissNotification(event, id) {
    event.stopPropagation();
    dismissNotifId(id);
    currentNotifications = currentNotifications.filter(n => n.id !== id);
    renderNotifications();
}

function clearAllNotifications() {
    currentNotifications.forEach(n => dismissNotifId(n.id));
    currentNotifications = [];
    renderNotifications();
}

function toggleNotifDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('notifDropdown');
    const willOpen = !dropdown.classList.contains('active');
    dropdown.classList.toggle('active', willOpen);
    if (willOpen) loadNotifications();
}

function closeNotifDropdown() {
    const dropdown = document.getElementById('notifDropdown');
    if (dropdown) dropdown.classList.remove('active');
}

document.addEventListener('click', (e) => {
    const wrap = document.getElementById('notifWrap');
    if (wrap && !wrap.contains(e.target)) closeNotifDropdown();
});

// === NAVIGATION ===
function navTo(page) {
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

    document.getElementById(page).classList.add('active');
    const btn = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (btn) btn.classList.add('active');

    if (page === 'dashboard') loadDashboard();
    if (page === 'attendance') { loadHistory(); generateCalendar(currentYear, currentMonth); }
    if (page === 'leave') loadLeaves();
    if (page === 'activities') loadActivities();
    if (page === 'admin') loadAdmin();
}

// === DATA LOADING ===
async function loadInitialData() {
    const res = await fetch('/api/user/me', { headers: getHeaders() });
    if (!res.ok) { logout(); return; }

    const user = await res.json();
    currentUser = user;

    const initials = user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('miniName').innerText = user.name;
    document.getElementById('miniAvatar').innerText = initials;
    document.getElementById('topAvatar').innerText = initials;
    document.getElementById('welcomeText').innerText = `Good morning, ${user.name.split(' ')[0]} 👋`;

    document.getElementById('profName').innerText = user.name;
    document.getElementById('profEmail').innerText = user.email;
    document.getElementById('profAvatar').innerText = initials;
    document.getElementById('profRoleCompany').innerText = `${user.company}`;

    if (user.role === 'admin') {
        document.body.classList.add('is-admin');
        document.getElementById('profRoleBadge').className = 'badge badge-admin';
        document.getElementById('profRoleBadge').innerText = 'Administrator';
    } else {
        document.body.classList.remove('is-admin');
        document.getElementById('profRoleBadge').className = 'badge badge-present';
        document.getElementById('profRoleBadge').innerText = 'Employee';
    }

    const d = new Date();
    document.getElementById('welcomeDate').innerText = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    startClock();
    navTo('dashboard');
    loadNotifications();
    if (notifPollInterval) clearInterval(notifPollInterval);
    notifPollInterval = setInterval(loadNotifications, 30000);
}

function startClock() {
    setInterval(() => {
        document.getElementById('liveTime').innerText = new Date().toLocaleTimeString('en-US');
    }, 1000);
    document.getElementById('liveDate').innerText = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// === HELPERS ===
function formatMinutes(mins) {
    if (mins === null || mins === undefined) return '—';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
}

function shiftLabel(shiftType) {
    if (!shiftType) return '—';
    return shiftType === 'overtime' ? 'Overtime' : 'Regular';
}

function statusBadgeClass(status) {
    if (status === 'Half Day') return 'badge-pending';
    if (status === 'Present') return 'badge-present';
    return 'badge-pending';
}

function activityStatusBadgeClass(status) {
    if (status === 'Completed') return 'badge-approved';
    if (status === 'In Progress') return 'badge-inprogress';
    if (status === 'On Hold') return 'badge-onhold';
    return 'badge-pending';
}

// === BIOMETRIC SCAN FLOW ===
// Simulates a real fingerprint/face scanner: shows a scanning animation,
// then produces a scan id the way a biometric device/SDK would, and sends
// it to the server with the action. Every clock-in/out and break event
// goes through this — there is no manual/typed alternative.
function generateBiometricScanId() {
    if (window.crypto && crypto.randomUUID) return 'scan-' + crypto.randomUUID();
    return 'scan-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function openBioModal(title, subtitle) {
    document.getElementById('bioTitle').innerText = title;
    document.getElementById('bioSubtitle').innerText = subtitle;
    document.getElementById('bioError').style.display = 'none';
    document.getElementById('bioIcon').classList.add('scanning');
    document.getElementById('bioModal').classList.add('active');
}
function closeBioModal() {
    document.getElementById('bioModal').classList.remove('active');
    document.getElementById('bioIcon').classList.remove('scanning');
}

const BIO_ACTION_META = {
    'clock-in': { title: 'Clock In', subtitle: 'Scanning fingerprint to clock in…', endpoint: '/api/attendance/clock-in' },
    'clock-out': { title: 'Clock Out', subtitle: 'Scanning fingerprint to clock out…', endpoint: '/api/attendance/clock-out' },
    'break-start': { title: 'Start Break', subtitle: 'Scanning fingerprint to start your break…', endpoint: '/api/attendance/break/start' },
    'break-end': { title: 'End Break', subtitle: 'Scanning fingerprint to end your break…', endpoint: '/api/attendance/break/end' }
};

async function startBiometricAction(action) {
    const meta = BIO_ACTION_META[action];
    openBioModal(meta.title, meta.subtitle);

    // Simulated scan latency, like a real biometric device reading + matching.
    await new Promise(r => setTimeout(r, 1400));

    const biometricId = generateBiometricScanId();
    const body = { biometric_id: biometricId };
    if (action === 'break-start') {
        body.break_type = document.getElementById('breakTypeSelect').value;
    }

    try {
        const res = await fetch(meta.endpoint, { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) {
            document.getElementById('bioIcon').classList.remove('scanning');
            document.getElementById('bioError').style.display = 'block';
            document.getElementById('bioError').innerText = data.error || 'Verification failed.';
            document.getElementById('bioSubtitle').innerText = 'Scan not accepted.';
            setTimeout(closeBioModal, 1600);
            return;
        }
        document.getElementById('bioSubtitle').innerText = 'Verified ✓';
        setTimeout(closeBioModal, 500);
        loadTodayAttendance();
        loadNotifications();
        if (action === 'clock-out') loadBalance();
    } catch (e) {
        document.getElementById('bioError').style.display = 'block';
        document.getElementById('bioError').innerText = 'Network error — please try again.';
        setTimeout(closeBioModal, 1600);
    }
}

// === DASHBOARD ===
async function loadDashboard() {
    loadTodayAttendance();
    loadBalance();

    const res = await fetch('/api/leave/status', { headers: getHeaders() });
    const rows = await res.json();
    const container = document.getElementById('recentLeavesList');
    if (rows.length === 0) {
        container.innerHTML = '<p style="font-size: 12px; color: var(--text-light);">No recent leaves.</p>';
    } else {
        container.innerHTML = rows.slice(0, 2).map(r => `
            <div class="leave-highlight">
                <div class="leave-highlight-header">
                    <span class="leave-type">${r.leave_type}</span>
                    <span class="leave-status status-${r.status.toLowerCase()}">${r.status}</span>
                </div>
                <div class="leave-date">${r.start_date} to ${r.end_date} (${r.days} days)</div>
            </div>
        `).join('');
    }
}

async function loadTodayAttendance() {
    const res = await fetch('/api/attendance/today', { headers: getHeaders() });
    const data = await res.json();

    const badge = document.getElementById('todayStatusBadge');
    const btnIn = document.getElementById('clockInBtn');
    const btnOut = document.getElementById('clockOutBtn');
    const breakStartBtn = document.getElementById('breakStartBtn');
    const breakEndBtn = document.getElementById('breakEndBtn');
    const breakTypeSelect = document.getElementById('breakTypeSelect');

    if (data) {
        badge.innerText = data.status ? data.status.toUpperCase() : 'PRESENT';
        badge.className = 'badge ' + statusBadgeClass(data.status);
        document.getElementById('clockInDisplay').innerText = data.clock_in || '—';
        document.getElementById('clockOutDisplay').innerText = data.clock_out || '—';
        document.getElementById('shiftDisplay').innerText = data.clock_out ? shiftLabel(data.shift_type) : (data.open_break ? 'On break' : 'In progress');
        document.getElementById('workHoursDisplay').innerText = data.clock_out ? formatMinutes(data.work_minutes) : '—';
        const reqOutEl = document.getElementById('requiredOutDisplay');
        if (reqOutEl) reqOutEl.innerText = data.required_clock_out || '—';

        btnIn.disabled = true;
        btnOut.disabled = !!data.clock_out || !!data.open_break;

        const allowance = data.break_allowance || 60;
        document.getElementById('breakAllowanceText').innerText = `(${allowance} min allowed)`;
        document.getElementById('breakTotalText').innerText = `${Math.round(data.break_minutes_live || 0)} min used` + (data.break_exceeded ? ' — over allowance' : '');

        const hasOpenBreak = !!data.open_break;
        breakStartBtn.disabled = !!data.clock_out || hasOpenBreak;
        breakEndBtn.disabled = !hasOpenBreak;
        breakTypeSelect.disabled = !!data.clock_out || hasOpenBreak;

        const list = document.getElementById('breakList');
        list.innerHTML = (data.breaks || []).map(b => `
            <div class="break-row">
                <span class="break-type-tag break-${b.break_type}">${b.break_type}</span>
                <span>${b.start_time} – ${b.end_time || 'ongoing'}</span>
                <span>${b.duration_minutes !== null && b.duration_minutes !== undefined ? formatMinutes(b.duration_minutes) : ''}</span>
            </div>
        `).join('') || '<p style="font-size:12px; color: var(--text-light);">No breaks taken yet today.</p>';
    } else {
        badge.innerText = 'NOT CLOCKED IN';
        badge.className = 'badge badge-absent';
        document.getElementById('clockInDisplay').innerText = '—';
        document.getElementById('clockOutDisplay').innerText = '—';
        document.getElementById('shiftDisplay').innerText = '—';
        document.getElementById('workHoursDisplay').innerText = '—';
        const reqOutElEmpty = document.getElementById('requiredOutDisplay');
        if (reqOutElEmpty) reqOutElEmpty.innerText = '—';
        document.getElementById('breakAllowanceText').innerText = '(60 min allowed)';
        document.getElementById('breakTotalText').innerText = '0 min used';
        document.getElementById('breakList').innerHTML = '<p style="font-size:12px; color: var(--text-light);">Clock in to start tracking breaks.</p>';

        btnIn.disabled = false;
        btnOut.disabled = true;
        breakStartBtn.disabled = true;
        breakEndBtn.disabled = true;
        breakTypeSelect.disabled = true;
    }
}

async function loadBalance() {
    const res = await fetch('/api/leave/balance', { headers: getHeaders() });
    const b = await res.json();
    document.getElementById('statCasual').innerText = (b.casual.total - b.casual.used) + 'd';
    document.getElementById('statSick').innerText = (b.sick.total - b.sick.used) + 'd';
    document.getElementById('statLeave').innerText = (b.casual.used + b.sick.used);

    const mRes = await fetch(`/api/attendance/month?y=${currentYear}&m=${currentMonth}`, { headers: getHeaders() });
    const mData = await mRes.json();
    document.getElementById('statPresent').innerText = mData.attendances.length;
}

// === ATTENDANCE ===
async function loadHistory() {
    const res = await fetch('/api/attendance/history', { headers: getHeaders() });
    const rows = await res.json();
    document.getElementById('attHistoryTable').innerHTML = rows.map(r => `
        <tr>
            <td>${r.date}</td>
            <td>${r.clock_in || '-'}</td>
            <td>${r.clock_out || '-'}</td>
            <td>${r.clock_out ? shiftLabel(r.shift_type) : '-'}</td>
            <td>${Math.round(r.break_minutes_live || 0)}m${r.break_exceeded ? ' ⚠' : ''}</td>
            <td>${r.clock_out ? formatMinutes(r.work_minutes) : '-'}</td>
            <td><span class="badge ${statusBadgeClass(r.status)}">${r.status || '-'}</span></td>
        </tr>
    `).join('') || '<tr><td colspan="7">No records found</td></tr>';
}

function changeMonth(dir) {
    currentMonth += dir;
    if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    if (currentMonth < 1) { currentMonth = 12; currentYear--; }
    generateCalendar(currentYear, currentMonth);
}

async function generateCalendar(year, month) {
    const res = await fetch(`/api/attendance/month?y=${year}&m=${month}`, { headers: getHeaders() });
    const data = await res.json();

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('calMonthTitle').innerText = `${monthNames[month - 1]} ${year}`;

    const daysContainer = document.getElementById('calendarDays');
    daysContainer.innerHTML = '';

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
        daysContainer.innerHTML += `<div class="day empty"></div>`;
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${month.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;

        let cls = 'day';
        if (dateStr === todayStr) cls += ' today';

        const att = data.attendances.find(a => a.date === dateStr);
        if (att) cls += ' present';

        const lv = data.leaves.find(l => dateStr >= l.start_date && dateStr <= l.end_date && l.status === 'Approved');
        if (lv) {
            cls = cls.replace('present', '');
            cls += ' leave';
        }

        const dObj = new Date(year, month - 1, d);
        // Only Sunday is a day off now — Saturday is a working day, so a
        // past Saturday with no attendance/leave is marked absent too.
        if (dateStr < todayStr && !att && !lv && dObj.getDay() !== 0) {
            cls += ' absent';
        }

        daysContainer.innerHTML += `<div class="${cls}">${d}</div>`;
    }
}

// === LEAVE ===
async function submitLeave() {
    const type = document.getElementById('leaveType').value;
    const start = document.getElementById('leaveStart').value;
    const end = document.getElementById('leaveEnd').value;
    const reason = document.getElementById('leaveReason').value;

    const res = await fetch('/api/leave/apply', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ leave_type: type, start_date: start, end_date: end, reason })
    });
    const data = await res.json();
    const msg = document.getElementById('leaveMsg');

    if (!res.ok) {
        msg.style.color = 'var(--red)';
        msg.innerText = data.error;
    } else {
        msg.style.color = 'var(--green)';
        msg.innerText = "Leave applied successfully!";
        loadLeaves();
        loadBalance();
        loadNotifications();
    }
}

async function loadLeaves() {
    const res = await fetch('/api/leave/status', { headers: getHeaders() });
    const rows = await res.json();

    document.getElementById('leaveHistoryTable').innerHTML = rows.map(r => {
        let badgeCls = 'badge-pending';
        if (r.status === 'Approved') badgeCls = 'badge-approved';
        if (r.status === 'Rejected') badgeCls = 'badge-rejected';
        return `
            <tr>
                <td>${r.leave_type}</td>
                <td>${r.start_date} to ${r.end_date}</td>
                <td>${r.days}</td>
                <td><span class="badge ${badgeCls}">${r.status}</span></td>
            </tr>
        `;
    }).join('') || '<tr><td colspan="4">No leaves applied</td></tr>';
}

// === DAILY ACTIVITIES ===
let todayActivitiesCache = [];
let historyActivitiesCache = [];

function todayDateStr() {
    return new Date().toISOString().slice(0, 10);
}

async function loadActivities() {
    const dateInput = document.getElementById('actHistoryDate');
    const monthInput = document.getElementById('actHistoryMonth');
    const t = new Date();
    if (dateInput && !dateInput.value) dateInput.value = todayDateStr();
    if (monthInput && !monthInput.value) monthInput.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;

    await loadTodayActivities();
    await loadActivityHistoryByDate();
    await loadActivityMonthSummary();
}

function renderActivityTime(a) {
    if (a.start_time && a.end_time) return `${a.start_time} – ${a.end_time}`;
    if (a.start_time) return `${a.start_time} – ongoing`;
    return '—';
}

async function loadTodayActivities() {
    const res = await fetch(`/api/activities/day?date=${todayDateStr()}`, { headers: getHeaders() });
    if (!res.ok) return;
    const rows = await res.json();
    todayActivitiesCache = rows;
    document.getElementById('todayActivitiesTable').innerHTML = rows.map(a => `
        <tr>
            <td>${escapeHtml(a.task)}</td>
            <td>${escapeHtml(a.category || '—')}</td>
            <td>${renderActivityTime(a)}</td>
            <td><span class="badge ${activityStatusBadgeClass(a.status)}">${a.status}</span></td>
            <td style="font-size:12px; color: var(--text-light);">${escapeHtml(a.remarks || '—')}</td>
            <td style="white-space:nowrap;">
                <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="editActivity(${a.id})">Edit</button>
                <button class="btn btn-red" style="padding:4px 8px; font-size:11px;" onclick="deleteActivityRow(${a.id})">Delete</button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="6">No tasks logged yet today.</td></tr>';
}

async function submitActivity() {
    const task = document.getElementById('actTask').value;
    const category = document.getElementById('actCategory').value;
    const start_time = document.getElementById('actStart').value;
    const end_time = document.getElementById('actEnd').value;
    const status = document.getElementById('actStatus').value;
    const remarks = document.getElementById('actRemarks').value;
    const msg = document.getElementById('actMsg');

    const res = await fetch('/api/activities', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ task, category, start_time, end_time, status, remarks })
    });
    const data = await res.json();
    if (!res.ok) {
        msg.style.color = 'var(--red)';
        msg.innerText = data.error;
        return;
    }
    msg.style.color = 'var(--green)';
    msg.innerText = 'Task logged!';
    document.getElementById('actTask').value = '';
    document.getElementById('actCategory').value = '';
    document.getElementById('actStart').value = '';
    document.getElementById('actEnd').value = '';
    document.getElementById('actRemarks').value = '';
    document.getElementById('actStatus').value = 'Completed';

    loadTodayActivities();
    loadActivityHistoryByDate();
    loadActivityMonthSummary();
}

async function loadActivityHistoryByDate() {
    const date = document.getElementById('actHistoryDate').value || todayDateStr();
    const res = await fetch(`/api/activities/day?date=${date}`, { headers: getHeaders() });
    if (!res.ok) return;
    const rows = await res.json();
    historyActivitiesCache = rows;
    document.getElementById('actHistoryTable').innerHTML = rows.map(a => `
        <tr>
            <td>${escapeHtml(a.task)}</td>
            <td>${escapeHtml(a.category || '—')}</td>
            <td>${renderActivityTime(a)}</td>
            <td><span class="badge ${activityStatusBadgeClass(a.status)}">${a.status}</span></td>
            <td style="font-size:12px; color: var(--text-light);">${escapeHtml(a.remarks || '—')}</td>
        </tr>
    `).join('') || '<tr><td colspan="5">No tasks logged for this date.</td></tr>';
}

async function loadActivityMonthSummary() {
    const monthVal = document.getElementById('actHistoryMonth').value; // "YYYY-MM"
    if (!monthVal) return;
    const [y, m] = monthVal.split('-');
    const res = await fetch(`/api/activities/month?y=${y}&m=${m}`, { headers: getHeaders() });
    if (!res.ok) return;
    const rows = await res.json();

    const byDate = {};
    rows.forEach(a => {
        if (!byDate[a.date]) byDate[a.date] = { total: 0, Completed: 0, 'In Progress': 0, Pending: 0, 'On Hold': 0 };
        byDate[a.date].total++;
        if (byDate[a.date][a.status] !== undefined) byDate[a.date][a.status]++;
    });
    const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

    document.getElementById('actMonthSummaryTable').innerHTML = dates.map(d => {
        const s = byDate[d];
        return `
            <tr>
                <td>${d}</td>
                <td>${s.total}</td>
                <td>${s.Completed}</td>
                <td>${s['In Progress']}</td>
                <td>${s.Pending}</td>
                <td>${s['On Hold']}</td>
            </tr>
        `;
    }).join('') || '<tr><td colspan="6">No tasks logged this month.</td></tr>';
}

function findCachedActivity(id) {
    return todayActivitiesCache.find(a => a.id === id) || historyActivitiesCache.find(a => a.id === id);
}

function editActivity(id) {
    const a = findCachedActivity(id);
    if (!a) return;
    document.getElementById('editActId').value = a.id;
    document.getElementById('editActTask').value = a.task;
    document.getElementById('editActCategory').value = a.category || '';
    document.getElementById('editActStart').value = a.start_time || '';
    document.getElementById('editActEnd').value = a.end_time || '';
    document.getElementById('editActStatus').value = a.status;
    document.getElementById('editActRemarks').value = a.remarks || '';
    document.getElementById('editActMsg').innerText = '';
    document.getElementById('editActModal').classList.add('active');
}

function closeEditActModal() {
    document.getElementById('editActModal').classList.remove('active');
}

async function saveActivityEdit() {
    const id = document.getElementById('editActId').value;
    const task = document.getElementById('editActTask').value;
    const category = document.getElementById('editActCategory').value;
    const start_time = document.getElementById('editActStart').value;
    const end_time = document.getElementById('editActEnd').value;
    const status = document.getElementById('editActStatus').value;
    const remarks = document.getElementById('editActRemarks').value;
    const msg = document.getElementById('editActMsg');

    const res = await fetch(`/api/activities/${id}`, {
        method: 'PUT', headers: getHeaders(),
        body: JSON.stringify({ task, category, start_time, end_time, status, remarks })
    });
    const data = await res.json();
    if (!res.ok) {
        msg.style.color = 'var(--red)';
        msg.innerText = data.error;
        return;
    }
    closeEditActModal();
    loadTodayActivities();
    loadActivityHistoryByDate();
    loadActivityMonthSummary();
}

async function deleteActivityRow(id) {
    if (!confirm('Delete this task entry?')) return;
    const res = await fetch(`/api/activities/${id}`, { method: 'DELETE', headers: getHeaders() });
    if (res.ok) {
        loadTodayActivities();
        loadActivityHistoryByDate();
        loadActivityMonthSummary();
    }
}

// === ADMIN ===
async function loadAdmin() {
    const uRes = await fetch('/api/admin/users', { headers: getHeaders() });
    if (uRes.ok) {
        const users = await uRes.json();
        document.getElementById('adminUsersTable').innerHTML = users.map(u => `
            <tr class="clickable-row" onclick="openEmpModal(${u.id})">
                <td>${u.name}</td>
                <td>${u.email}</td>
                <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-present'}">${u.role}</span></td>
                <td><span class="badge ${u.status === 'active' ? 'badge-present' : 'badge-absent'}">${u.status}</span></td>
            </tr>
        `).join('');

        const empSelect = document.getElementById('actAdminEmployee');
        if (empSelect) {
            const prevValue = empSelect.value;
            empSelect.innerHTML = '<option value="">All Employees</option>' +
                users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
            empSelect.value = prevValue;
        }
    }

    loadAdminActivities();

    const lRes = await fetch('/api/admin/leaves', { headers: getHeaders() });
    if (lRes.ok) {
        const leaves = await lRes.json();
        document.getElementById('adminLeavesTable').innerHTML = leaves.filter(l => l.status === 'Pending').map(l => `
            <tr>
                <td>${l.user_name}</td>
                <td>${l.leave_type}</td>
                <td>${l.start_date} to ${l.end_date}</td>
                <td>${l.days}</td>
                <td>
                    <button class="btn btn-green" style="padding: 5px 10px; font-size:10px;" onclick="leaveDecision(${l.id}, 'Approved')">Approve</button>
                    <button class="btn btn-red" style="padding: 5px 10px; font-size:10px;" onclick="leaveDecision(${l.id}, 'Rejected')">Reject</button>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="5">No pending requests</td></tr>';
    }

    const aRes = await fetch('/api/admin/attendance', { headers: getHeaders() });
    if (aRes.ok) {
        const rows = await aRes.json();
        document.getElementById('adminAttendanceTable').innerHTML = rows.slice(0, 50).map(r => `
            <tr>
                <td>${r.user_name}</td>
                <td>${r.date}</td>
                <td>${r.clock_in || '-'}</td>
                <td>${r.clock_out || '-'}</td>
                <td>${r.clock_out ? shiftLabel(r.shift_type) : '-'}</td>
                <td>${Math.round(r.break_minutes_live || 0)}m${r.break_exceeded ? ' ⚠' : ''}</td>
                <td>${r.clock_out ? formatMinutes(r.work_minutes) : '-'}</td>
                <td><span class="badge ${statusBadgeClass(r.status)}">${r.status || '-'}</span></td>
            </tr>
        `).join('') || '<tr><td colspan="8">No attendance recorded yet</td></tr>';
    }

    const auRes = await fetch('/api/admin/audit-log', { headers: getHeaders() });
    if (auRes.ok) {
        const rows = await auRes.json();
        document.getElementById('adminAuditTable').innerHTML = rows.map(r => `
            <tr>
                <td style="white-space:nowrap;">${r.created_at}</td>
                <td>${r.actor_name || 'system'}</td>
                <td>${r.action}</td>
                <td style="font-size:11px; color: var(--text-light);">${r.details ? escapeHtml(r.details) : ''}</td>
            </tr>
        `).join('') || '<tr><td colspan="4">No activity yet</td></tr>';
    }
}

async function loadAdminActivities() {
    const empId = document.getElementById('actAdminEmployee') ? document.getElementById('actAdminEmployee').value : '';
    const date = document.getElementById('actAdminDate') ? document.getElementById('actAdminDate').value : '';
    const month = document.getElementById('actAdminMonth') ? document.getElementById('actAdminMonth').value : '';

    const params = new URLSearchParams();
    if (empId) params.set('user_id', empId);
    if (date) params.set('date', date);
    else if (month) params.set('month', month);

    const res = await fetch(`/api/admin/activities?${params.toString()}`, { headers: getHeaders() });
    if (!res.ok) return;
    const rows = await res.json();
    document.getElementById('adminActivitiesTable').innerHTML = rows.slice(0, 200).map(a => `
        <tr>
            <td>${escapeHtml(a.user_name)}</td>
            <td>${a.date}</td>
            <td>${escapeHtml(a.task)}</td>
            <td>${escapeHtml(a.category || '—')}</td>
            <td>${renderActivityTime(a)}</td>
            <td><span class="badge ${activityStatusBadgeClass(a.status)}">${a.status}</span></td>
            <td style="font-size:12px; color: var(--text-light);">${escapeHtml(a.remarks || '—')}</td>
        </tr>
    `).join('') || '<tr><td colspan="7">No activities found for this filter.</td></tr>';
}

function clearAdminActivityFilters() {
    document.getElementById('actAdminEmployee').value = '';
    document.getElementById('actAdminDate').value = '';
    document.getElementById('actAdminMonth').value = '';
    loadAdminActivities();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
}

async function addEmployee() {
    const name = document.getElementById('addName').value;
    const email = document.getElementById('addEmail').value;
    const password = document.getElementById('addPassword').value;
    const security_question = document.getElementById('addSecQuestion').value;
    const security_answer = document.getElementById('addSecAnswer').value;

    const res = await fetch('/api/register', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name, email, password, security_question, security_answer })
    });
    const msg = document.getElementById('addMsg');
    if (!res.ok) {
        const data = await res.json();
        msg.style.color = 'var(--red)';
        msg.innerText = data.error;
    } else {
        msg.style.color = 'var(--green)';
        msg.innerText = "Employee account created! Share these credentials with the employee.";
        document.getElementById('addName').value = '';
        document.getElementById('addEmail').value = '';
        document.getElementById('addPassword').value = '';
        document.getElementById('addSecQuestion').value = '';
        document.getElementById('addSecAnswer').value = '';
        loadAdmin();
    }
}

async function leaveDecision(id, status) {
    await fetch(`/api/admin/leaves/${id}/decision`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ status })
    });
    loadAdmin();
    loadNotifications();
}

// === ADMIN: EMPLOYEE DETAIL MODAL ===
async function openEmpModal(id) {
    const modal = document.getElementById('empModal');
    const body = document.getElementById('empModalBody');
    body.innerHTML = 'Loading…';
    modal.classList.add('active');

    const res = await fetch(`/api/admin/employee/${id}`, { headers: getHeaders() });
    if (!res.ok) {
        body.innerHTML = '<p class="error-msg">Could not load employee details.</p>';
        return;
    }
    const data = await res.json();
    const p = data.profile;

    const attRows = data.attendance.slice(0, 15).map(r => `
        <tr>
            <td>${r.date}</td>
            <td>${r.clock_in || '-'}</td>
            <td>${r.clock_out || '-'}</td>
            <td>${r.clock_out ? shiftLabel(r.shift_type) : '-'}</td>
            <td>${Math.round(r.break_minutes_live || 0)}m</td>
            <td>${r.clock_out ? formatMinutes(r.work_minutes) : '-'}</td>
            <td><span class="badge ${statusBadgeClass(r.status)}">${r.status || '-'}</span></td>
        </tr>
    `).join('') || '<tr><td colspan="7">No attendance recorded</td></tr>';

    const actRows = (data.activities || []).slice(0, 15).map(a => `
        <tr>
            <td>${a.date}</td>
            <td>${escapeHtml(a.task)}</td>
            <td>${escapeHtml(a.category || '—')}</td>
            <td>${renderActivityTime(a)}</td>
            <td><span class="badge ${activityStatusBadgeClass(a.status)}">${a.status}</span></td>
        </tr>
    `).join('') || '<tr><td colspan="5">No activities logged</td></tr>';

    const leaveRows = data.leaves.map(l => {
        let badgeCls = 'badge-pending';
        if (l.status === 'Approved') badgeCls = 'badge-approved';
        if (l.status === 'Rejected') badgeCls = 'badge-rejected';
        return `
            <tr>
                <td>${l.leave_type}</td>
                <td>${l.start_date} to ${l.end_date}</td>
                <td>${l.days}</td>
                <td><span class="badge ${badgeCls}">${l.status}</span></td>
            </tr>
        `;
    }).join('') || '<tr><td colspan="4">No leave requests</td></tr>';

    const statusToggle = p.role === 'admin' ? '' : `
        <button class="btn ${p.status === 'active' ? 'btn-red' : 'btn-green'}" style="padding:8px 14px; font-size:12px;"
            onclick="toggleEmployeeStatus(${p.id}, '${p.status === 'active' ? 'inactive' : 'active'}')">
            ${p.status === 'active' ? 'Deactivate Account' : 'Reactivate Account'}
        </button>`;

    body.innerHTML = `
        <div class="profile-card" style="margin-bottom: 20px;">
            <div class="profile-avatar">${p.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}</div>
            <div class="profile-info">
                <h2>${p.name}</h2>
                <p>${p.email}</p>
                <p>${p.company}</p>
                <p style="margin-top:8px;">
                    <span class="badge ${p.role === 'admin' ? 'badge-admin' : 'badge-present'}">${p.role}</span>
                    <span class="badge ${p.status === 'active' ? 'badge-present' : 'badge-absent'}">${p.status}</span>
                </p>
            </div>
        </div>
        <div style="margin-bottom: 20px; display:flex; gap:10px; flex-wrap:wrap;">
            ${statusToggle}
            <button class="btn btn-outline" style="padding:8px 14px; font-size:12px;" onclick="toggleResetPwBox(${p.id})">Reset Password</button>
        </div>
        <div class="card" id="resetPwBox_${p.id}" style="display:none; margin-bottom:20px; padding:16px;">
            <div class="form-group" style="margin:0 0 10px 0;">
                <label>New Password</label>
                <input type="password" id="resetPwInput_${p.id}" placeholder="New password (min 6 characters)" minlength="6">
            </div>
            <p id="resetPwMsg_${p.id}" style="font-size:12px; margin-bottom:10px;"></p>
            <button class="btn btn-primary" style="padding:8px 14px; font-size:12px;" onclick="submitAdminPasswordReset(${p.id})">Set New Password</button>
            <p style="font-size:11px; color: var(--text-light); margin-top:8px;">Use this when an employee has forgotten their password and can't recall their security answer. Share the new password with them directly.</p>
        </div>
        <div class="stats-grid" style="margin-bottom: 20px;">
            <div class="stat-card"><p>Casual Balance</p><h3>${p.casual_leave_total - data.leave_balance.casual.used}d</h3></div>
            <div class="stat-card"><p>Sick Balance</p><h3>${p.sick_leave_total - data.leave_balance.sick.used}d</h3></div>
        </div>
        <h3 style="margin-bottom: 10px;">Attendance History</h3>
        <div class="table-container" style="margin-bottom: 24px;">
            <table>
                <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Shift</th><th>Breaks</th><th>Work Hrs</th><th>Status</th></tr></thead>
                <tbody>${attRows}</tbody>
            </table>
        </div>
        <h3 style="margin-bottom: 10px;">Leave Requests</h3>
        <div class="table-container" style="margin-bottom: 24px;">
            <table>
                <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th></tr></thead>
                <tbody>${leaveRows}</tbody>
            </table>
        </div>
        <h3 style="margin-bottom: 10px;">Recent Daily Activities</h3>
        <div class="table-container">
            <table>
                <thead><tr><th>Date</th><th>Task</th><th>Category</th><th>Time</th><th>Status</th></tr></thead>
                <tbody>${actRows}</tbody>
            </table>
        </div>
    `;
}

function closeEmpModal() {
    document.getElementById('empModal').classList.remove('active');
}

async function toggleEmployeeStatus(id, status) {
    const res = await fetch(`/api/admin/employee/${id}/status`, {
        method: 'POST', headers: getHeaders(), body: JSON.stringify({ status })
    });
    if (res.ok) {
        openEmpModal(id);
        loadAdmin();
    }
}

function toggleResetPwBox(id) {
    const box = document.getElementById(`resetPwBox_${id}`);
    if (!box) return;
    const showing = box.style.display !== 'none';
    box.style.display = showing ? 'none' : 'block';
    if (!showing) {
        const input = document.getElementById(`resetPwInput_${id}`);
        if (input) { input.value = ''; input.focus(); }
        const msg = document.getElementById(`resetPwMsg_${id}`);
        if (msg) msg.innerText = '';
    }
}

async function submitAdminPasswordReset(id) {
    const input = document.getElementById(`resetPwInput_${id}`);
    const msg = document.getElementById(`resetPwMsg_${id}`);
    const new_password = input ? input.value : '';

    if (!new_password || new_password.length < 6) {
        msg.style.color = 'var(--red)';
        msg.innerText = 'Password must be at least 6 characters.';
        return;
    }

    const res = await fetch(`/api/admin/employee/${id}/reset-password`, {
        method: 'POST', headers: getHeaders(), body: JSON.stringify({ new_password })
    });
    const data = await res.json();
    if (!res.ok) {
        msg.style.color = 'var(--red)';
        msg.innerText = data.error;
        return;
    }
    msg.style.color = 'var(--green)';
    msg.innerText = 'Password reset! Share the new password with the employee.';
    if (input) input.value = '';
}
