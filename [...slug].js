/* ============================================================
   HRMS API — real backend
   ------------------------------------------------------------
   This single serverless function handles every /api/* route.
   It replaces the old localdb.js (which faked a backend using the
   browser's localStorage) with real PostgreSQL storage, so every
   employee can log in from their own device and see shared data.

   Deployed on Vercel, this file lives at /api/[...slug].js, which
   means Vercel routes ANY request under /api/ here — the [...slug]
   part captures the rest of the path (e.g. "admin/employee/5/status")
   as req.query.slug = ['admin','employee','5','status'].
   ============================================================ */

const { getPool } = require('../lib/db');
const {
  hashPassword, verifyPassword, hashAnswer, verifyAnswer, normalizeAnswer,
  makeToken, readToken
} = require('../lib/auth');
const {
  STANDARD_WORK_MINUTES, HALF_DAY_THRESHOLD_MINUTES, REQUIRED_SHIFT_SPAN_MINUTES,
  BREAK_TYPES, ACTIVITY_STATUSES,
  today, nowHHMM, diffMinutes, addMinutesHHMM,
  verifyBiometricScan, getOpenBreak, attendanceWithBreaks,
  findUserPublic, logAudit
} = require('../lib/helpers');

function requireAdmin(user) {
  return !!(user && user.role === 'admin');
}

// ---------- route table (same pattern-matching approach as the old app) ----------
const handlers = [];
function route(method, pattern, fn) { handlers.push({ method, pattern, fn }); }
function matchPath(pattern, parts) {
  const pParts = pattern.split('/').filter(Boolean);
  if (pParts.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = parts[i];
    else if (pParts[i] !== parts[i]) return null;
  }
  return params;
}

// ---------- auth / setup ----------
route('GET', '/setup-status', async (pool) => {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  return { status: 200, body: { initialized: r.rows[0].c > 0 } };
});

route('POST', '/register', async (pool, { body, req }) => {
  const { name, email, password, company, security_question, security_answer } = body || {};
  if (!name || !email || !password) return { status: 400, body: { error: 'Missing fields' } };
  if (!/^\S+@\S+\.\S+$/.test(email)) return { status: 400, body: { error: 'Invalid email address' } };
  if (password.length < 6) return { status: 400, body: { error: 'Password must be at least 6 characters' } };
  if (!security_question || !security_answer || !normalizeAnswer(security_answer)) {
    return { status: 400, body: { error: 'A security question and answer are required so this account can be recovered later' } };
  }

  const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  const userCount = countRes.rows[0].c;

  let actor = null;
  if (userCount > 0) {
    const decoded = readToken(req);
    if (!decoded) return { status: 401, body: { error: 'Only an admin can create employee accounts' } };
    if (decoded.role !== 'admin') return { status: 403, body: { error: 'Forbidden: Admin access required' } };
    actor = decoded;
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return { status: 400, body: { error: 'Email already registered' } };

  const role = userCount === 0 ? 'admin' : 'employee';
  const [hash, answerHash] = await Promise.all([hashPassword(password), hashAnswer(security_answer)]);

  const insertRes = await pool.query(
    `INSERT INTO users (name, email, password, company, role, security_question, security_answer_hash, casual_leave_total, sick_leave_total, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,12,8,'active') RETURNING id`,
    [name, email, hash, company || 'My Company', role, security_question, answerHash]
  );
  const id = insertRes.rows[0].id;
  await logAudit(pool, actor, userCount === 0 ? 'bootstrap_admin_created' : 'employee_account_created', 'user', id, { name, email, role });
  return { status: 200, body: { id, name, email, role } };
});

route('POST', '/login', async (pool, { body }) => {
  const { email, password } = body || {};
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = r.rows[0];
  if (!user) return { status: 401, body: { error: 'Invalid email or password' } };
  const okPw = await verifyPassword(password || '', user.password);
  if (!okPw) return { status: 401, body: { error: 'Invalid email or password' } };
  if (user.status && user.status !== 'active') return { status: 403, body: { error: 'This account has been deactivated. Contact HR/Admin.' } };
  const token = makeToken(user);
  await logAudit(pool, user, 'login', 'user', user.id, null);
  return { status: 200, body: { token, name: user.name, company: user.company, role: user.role, id: user.id } };
});

route('POST', '/forgot-password/question', async (pool, { body }) => {
  const { email } = body || {};
  const r = await pool.query('SELECT security_question FROM users WHERE email = $1', [email]);
  const user = r.rows[0];
  if (!user) return { status: 404, body: { error: 'No account found with that email' } };
  if (!user.security_question) return { status: 400, body: { error: 'This account has no security question on file. Contact your admin to reset your password.' } };
  return { status: 200, body: { question: user.security_question } };
});

route('POST', '/forgot-password/reset', async (pool, { body }) => {
  const { email, answer, new_password } = body || {};
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = r.rows[0];
  if (!user) return { status: 404, body: { error: 'No account found with that email' } };
  if (!user.security_question || !user.security_answer_hash) {
    return { status: 400, body: { error: 'This account has no security question on file. Contact your admin to reset your password.' } };
  }
  if (!new_password || new_password.length < 6) return { status: 400, body: { error: 'New password must be at least 6 characters' } };
  const answerOk = await verifyAnswer(answer, user.security_answer_hash);
  if (!answerOk) return { status: 401, body: { error: "That answer doesn't match our records" } };
  const hash = await hashPassword(new_password);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
  await logAudit(pool, null, 'password_reset_self', 'user', user.id, { email });
  return { status: 200, body: { ok: true } };
});

route('GET', '/user/me', async (pool, { user }) => {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
  if (!r.rows[0]) return { status: 404, body: { error: 'User not found' } };
  return { status: 200, body: findUserPublic(r.rows[0]) };
});

// ---------- attendance ----------
route('GET', '/attendance/today', async (pool, { user }) => {
  const r = await pool.query('SELECT * FROM attendance WHERE user_id = $1 AND date = $2', [user.id, today()]);
  return { status: 200, body: attendanceWithBreaks(r.rows[0]) };
});

route('POST', '/attendance/clock-in', async (pool, { user, body }) => {
  const { biometric_id } = body || {};
  if (!verifyBiometricScan(biometric_id)) return { status: 400, body: { error: 'Biometric verification failed. Please scan again.' } };
  const existing = await pool.query('SELECT id FROM attendance WHERE user_id = $1 AND date = $2', [user.id, today()]);
  if (existing.rows.length) return { status: 400, body: { error: 'Already clocked in today' } };

  const clockInTime = nowHHMM();
  const requiredClockOut = addMinutesHHMM(clockInTime, REQUIRED_SHIFT_SPAN_MINUTES);
  const status = 'Present';
  const insertRes = await pool.query(
    `INSERT INTO attendance (user_id, date, clock_in, clock_in_method, biometric_in_id, required_clock_out, status, shift_type, breaks)
     VALUES ($1,$2,$3,'biometric',$4,$5,$6,'regular','[]'::jsonb) RETURNING id`,
    [user.id, today(), clockInTime, biometric_id, requiredClockOut, status]
  );
  await logAudit(pool, user, 'clock_in', 'attendance', insertRes.rows[0].id, { time: clockInTime, status, required_clock_out: requiredClockOut });
  return { status: 200, body: { ok: true, clock_in: clockInTime, status, required_clock_out: requiredClockOut } };
});

route('POST', '/attendance/break/start', async (pool, { user, body }) => {
  const { break_type, biometric_id } = body || {};
  if (!verifyBiometricScan(biometric_id)) return { status: 400, body: { error: 'Biometric verification failed. Please scan again.' } };
  if (!BREAK_TYPES.includes(break_type)) return { status: 400, body: { error: 'Invalid break type' } };
  const r = await pool.query('SELECT * FROM attendance WHERE user_id = $1 AND date = $2', [user.id, today()]);
  const att = r.rows[0];
  if (!att || !att.clock_in) return { status: 400, body: { error: 'You must clock in before taking a break' } };
  if (att.clock_out) return { status: 400, body: { error: 'You have already clocked out for today' } };
  if (getOpenBreak(att.breaks)) return { status: 400, body: { error: 'A break is already in progress' } };

  const startTime = nowHHMM();
  const brkId = Date.now();
  const brk = { id: brkId, break_type, start_time: startTime, end_time: null, method: 'biometric', biometric_start_id: biometric_id, biometric_end_id: null, duration_minutes: null };
  const breaks = [...(att.breaks || []), brk];
  await pool.query('UPDATE attendance SET breaks = $1 WHERE id = $2', [JSON.stringify(breaks), att.id]);
  await logAudit(pool, user, 'break_start', 'attendance_break', brkId, { break_type, time: startTime });
  return { status: 200, body: { ok: true, id: brkId, break_type, start_time: startTime } };
});

route('POST', '/attendance/break/end', async (pool, { user, body }) => {
  const { biometric_id } = body || {};
  if (!verifyBiometricScan(biometric_id)) return { status: 400, body: { error: 'Biometric verification failed. Please scan again.' } };
  const r = await pool.query('SELECT * FROM attendance WHERE user_id = $1 AND date = $2', [user.id, today()]);
  const att = r.rows[0];
  if (!att) return { status: 400, body: { error: 'No attendance record for today' } };
  const breaks = att.breaks || [];
  const openBreak = getOpenBreak(breaks);
  if (!openBreak) return { status: 400, body: { error: 'No break in progress' } };

  const endTime = nowHHMM();
  const duration = diffMinutes(openBreak.start_time, endTime);
  const updatedBreaks = breaks.map(b => b.id === openBreak.id
    ? { ...b, end_time: endTime, biometric_end_id: biometric_id, duration_minutes: duration }
    : b);
  await pool.query('UPDATE attendance SET breaks = $1 WHERE id = $2', [JSON.stringify(updatedBreaks), att.id]);
  await logAudit(pool, user, 'break_end', 'attendance_break', openBreak.id, { break_type: openBreak.break_type, duration_minutes: duration });
  return { status: 200, body: { ok: true, end_time: endTime, duration_minutes: duration } };
});

route('POST', '/attendance/clock-out', async (pool, { user, body }) => {
  const { biometric_id } = body || {};
  if (!verifyBiometricScan(biometric_id)) return { status: 400, body: { error: 'Biometric verification failed. Please scan again.' } };
  const r = await pool.query('SELECT * FROM attendance WHERE user_id = $1 AND date = $2', [user.id, today()]);
  const att = r.rows[0];
  if (!att) return { status: 400, body: { error: 'Not clocked in yet' } };
  if (att.clock_out) return { status: 400, body: { error: 'Already clocked out today' } };
  if (getOpenBreak(att.breaks)) return { status: 400, body: { error: 'End your current break before clocking out' } };

  const clockOutTime = nowHHMM();
  const breakMinutes = (att.breaks || []).reduce((s, b) => s + (b.duration_minutes || 0), 0);
  const rawMinutes = diffMinutes(att.clock_in, clockOutTime);
  const workMinutes = Math.max(0, rawMinutes - breakMinutes);
  const shiftType = workMinutes > STANDARD_WORK_MINUTES ? 'overtime' : 'regular';
  const overtimeMinutes = Math.max(0, workMinutes - STANDARD_WORK_MINUTES);
  let status = 'Present';
  if (workMinutes < HALF_DAY_THRESHOLD_MINUTES) status = 'Half Day';

  await pool.query(
    `UPDATE attendance SET clock_out=$1, clock_out_method='biometric', biometric_out_id=$2,
       shift_type=$3, work_minutes=$4, break_minutes=$5, overtime_minutes=$6, status=$7
     WHERE id = $8`,
    [clockOutTime, biometric_id, shiftType, workMinutes, breakMinutes, overtimeMinutes, status, att.id]
  );
  await logAudit(pool, user, 'clock_out', 'attendance', att.id, { time: clockOutTime, shift_type: shiftType, work_minutes: workMinutes, break_minutes: breakMinutes, overtime_minutes: overtimeMinutes, status });
  return { status: 200, body: { ok: true, clock_out: clockOutTime, shift_type: shiftType, work_minutes: workMinutes, break_minutes: breakMinutes, overtime_minutes: overtimeMinutes, status } };
});

route('GET', '/attendance/history', async (pool, { user }) => {
  const r = await pool.query('SELECT * FROM attendance WHERE user_id = $1 ORDER BY date DESC LIMIT 60', [user.id]);
  return { status: 200, body: r.rows.map(attendanceWithBreaks) };
});

route('GET', '/attendance/month', async (pool, { user, query }) => {
  const y = query.y, m = query.m;
  if (!y || !m) return { status: 400, body: { error: 'Year and month required' } };
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  const attRes = await pool.query(`SELECT * FROM attendance WHERE user_id = $1 AND date::text LIKE $2`, [user.id, `${prefix}%`]);
  const leaveRes = await pool.query(
    `SELECT * FROM leaves WHERE user_id = $1 AND (start_date::text LIKE $2 OR end_date::text LIKE $2)`,
    [user.id, `${prefix}%`]
  );
  return { status: 200, body: { attendances: attRes.rows.map(attendanceWithBreaks), leaves: leaveRes.rows } };
});

// ---------- leave ----------
route('GET', '/leave/balance', async (pool, { user }) => {
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
  const u = uRes.rows[0];
  const approvedRes = await pool.query(`SELECT * FROM leaves WHERE user_id = $1 AND status = 'Approved'`, [user.id]);
  const usedOf = (type) => approvedRes.rows.filter(l => l.leave_type === type).reduce((s, l) => s + Number(l.days), 0);
  return {
    status: 200,
    body: {
      casual: { total: Number(u.casual_leave_total), used: usedOf('Casual Leave') },
      sick: { total: Number(u.sick_leave_total), used: usedOf('Sick Leave') }
    }
  };
});

route('POST', '/leave/apply', async (pool, { user, body }) => {
  const { leave_type, start_date, end_date, reason } = body || {};
  if (!leave_type || !start_date || !end_date) return { status: 400, body: { error: 'Missing fields' } };
  const days = (new Date(end_date) - new Date(start_date)) / 86400000 + 1;
  if (days <= 0 || Number.isNaN(days)) return { status: 400, body: { error: 'Invalid date range' } };
  const insertRes = await pool.query(
    `INSERT INTO leaves (user_id, leave_type, start_date, end_date, days, reason, status, applied_on)
     VALUES ($1,$2,$3,$4,$5,$6,'Pending',$7) RETURNING id`,
    [user.id, leave_type, start_date, end_date, days, reason || '', today()]
  );
  await logAudit(pool, user, 'leave_applied', 'leave', insertRes.rows[0].id, { leave_type, start_date, end_date, days });
  return { status: 200, body: { ok: true, days } };
});

route('GET', '/leave/status', async (pool, { user }) => {
  const r = await pool.query('SELECT * FROM leaves WHERE user_id = $1 ORDER BY applied_on DESC', [user.id]);
  return { status: 200, body: r.rows };
});

// ---------- daily activities ----------
route('GET', '/activities/day', async (pool, { user, query }) => {
  const date = query.date || today();
  const r = await pool.query('SELECT * FROM activities WHERE user_id = $1 AND date = $2 ORDER BY start_time', [user.id, date]);
  return { status: 200, body: r.rows };
});

route('GET', '/activities/month', async (pool, { user, query }) => {
  const y = query.y, m = query.m;
  if (!y || !m) return { status: 400, body: { error: 'Year and month required' } };
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  const r = await pool.query(
    `SELECT * FROM activities WHERE user_id = $1 AND date::text LIKE $2 ORDER BY date DESC, start_time DESC`,
    [user.id, `${prefix}%`]
  );
  return { status: 200, body: r.rows };
});

route('POST', '/activities', async (pool, { user, body }) => {
  const { task, category, start_time, end_time, status, remarks } = body || {};
  if (!task || !task.trim()) return { status: 400, body: { error: 'Task description is required' } };
  const activityStatus = ACTIVITY_STATUSES.includes(status) ? status : 'Pending';
  const date = today();
  const insertRes = await pool.query(
    `INSERT INTO activities (user_id, date, task, category, start_time, end_time, status, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [user.id, date, task.trim(), (category || '').trim(), start_time || null, end_time || null, activityStatus, (remarks || '').trim()]
  );
  await logAudit(pool, user, 'activity_logged', 'activity', insertRes.rows[0].id, { task: insertRes.rows[0].task, status: activityStatus, date });
  return { status: 200, body: insertRes.rows[0] };
});

route('PUT', '/activities/:id', async (pool, { user, params, body }) => {
  const r = await pool.query('SELECT * FROM activities WHERE id = $1', [Number(params.id)]);
  const activity = r.rows[0];
  if (!activity) return { status: 404, body: { error: 'Activity not found' } };
  if (activity.user_id !== user.id) return { status: 403, body: { error: 'You can only edit your own activities' } };
  if (String(activity.date) !== today()) return { status: 400, body: { error: "Only today's activities can be edited" } };

  const { task, category, start_time, end_time, status, remarks } = body || {};
  if (task !== undefined && !task.trim()) return { status: 400, body: { error: 'Task description is required' } };

  const next = {
    task: task !== undefined ? task.trim() : activity.task,
    category: category !== undefined ? (category || '').trim() : activity.category,
    start_time: start_time !== undefined ? (start_time || null) : activity.start_time,
    end_time: end_time !== undefined ? (end_time || null) : activity.end_time,
    status: status !== undefined ? (ACTIVITY_STATUSES.includes(status) ? status : activity.status) : activity.status,
    remarks: remarks !== undefined ? (remarks || '').trim() : activity.remarks
  };
  const updRes = await pool.query(
    `UPDATE activities SET task=$1, category=$2, start_time=$3, end_time=$4, status=$5, remarks=$6, updated_at=NOW()
     WHERE id = $7 RETURNING *`,
    [next.task, next.category, next.start_time, next.end_time, next.status, next.remarks, activity.id]
  );
  await logAudit(pool, user, 'activity_updated', 'activity', activity.id, { task: next.task, status: next.status });
  return { status: 200, body: updRes.rows[0] };
});

route('DELETE', '/activities/:id', async (pool, { user, params }) => {
  const r = await pool.query('SELECT * FROM activities WHERE id = $1', [Number(params.id)]);
  const activity = r.rows[0];
  if (!activity) return { status: 404, body: { error: 'Activity not found' } };
  if (activity.user_id !== user.id) return { status: 403, body: { error: 'You can only delete your own activities' } };
  if (String(activity.date) !== today()) return { status: 400, body: { error: "Only today's activities can be deleted" } };
  await pool.query('DELETE FROM activities WHERE id = $1', [activity.id]);
  await logAudit(pool, user, 'activity_deleted', 'activity', activity.id, { task: activity.task });
  return { status: 200, body: { ok: true } };
});

// ---------- notifications (derived, not stored) ----------
route('GET', '/notifications', async (pool, { user }) => {
  const notifications = [];

  if (requireAdmin(user)) {
    const pendingLeaves = await pool.query(
      `SELECT l.*, u.name AS user_name FROM leaves l JOIN users u ON u.id = l.user_id WHERE l.status = 'Pending'`
    );
    pendingLeaves.rows.forEach(l => {
      notifications.push({
        id: `leave-pending-${l.id}`, type: 'leave_pending',
        text: `${l.user_name || 'An employee'} requested ${l.leave_type} (${l.start_date} to ${l.end_date})`,
        time: l.applied_on, page: 'admin'
      });
    });

    const todayAtt = await pool.query(
      `SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.date = $1`,
      [today()]
    );
    todayAtt.rows.forEach(a => {
      const withBreaks = attendanceWithBreaks(a);
      if (withBreaks.break_exceeded) {
        notifications.push({
          id: `break-exceeded-${a.id}`, type: 'break_exceeded',
          text: `${a.user_name || 'An employee'} has exceeded their break allowance today (${Math.round(withBreaks.break_minutes_live)}m used / ${withBreaks.break_allowance}m allowed)`,
          time: a.clock_in, page: 'admin'
        });
      }
    });
  } else {
    const attRes = await pool.query('SELECT * FROM attendance WHERE user_id = $1 AND date = $2', [user.id, today()]);
    const att = attRes.rows[0];
    if (att) {
      const withBreaks = attendanceWithBreaks(att);
      if (withBreaks.break_exceeded) {
        notifications.push({
          id: `break-exceeded-${att.id}`, type: 'break_exceeded',
          text: `You've exceeded your break allowance today (${Math.round(withBreaks.break_minutes_live)}m used / ${withBreaks.break_allowance}m allowed)`,
          time: att.clock_in, page: 'dashboard'
        });
      }
      if (!att.clock_out && att.required_clock_out && nowHHMM() > att.required_clock_out) {
        notifications.push({
          id: `past-required-out-${att.id}`, type: 'past_required_out',
          text: `You're past your required clock-out time of ${att.required_clock_out}`,
          time: att.required_clock_out, page: 'dashboard'
        });
      }
    }
    const decidedLeaves = await pool.query(
      `SELECT * FROM leaves WHERE user_id = $1 AND status != 'Pending' AND decided_by IS NOT NULL`,
      [user.id]
    );
    decidedLeaves.rows.forEach(l => {
      notifications.push({
        id: `leave-decided-${l.id}`, type: 'leave_decided',
        text: `Your ${l.leave_type} request (${l.start_date} to ${l.end_date}) was ${String(l.status).toLowerCase()}`,
        time: l.applied_on, page: 'leave'
      });
    });
  }

  notifications.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return { status: 200, body: notifications };
});

// ---------- admin ----------
route('GET', '/admin/users', async (pool, { user }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const r = await pool.query('SELECT * FROM users ORDER BY name');
  return { status: 200, body: r.rows.map(findUserPublic) };
});

route('GET', '/admin/attendance', async (pool, { user, query }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const date = query.date;
  let r;
  if (date) {
    r = await pool.query(
      `SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id
       WHERE a.date = $1 ORDER BY a.date DESC, a.clock_in DESC LIMIT 200`,
      [date]
    );
  } else {
    r = await pool.query(
      `SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id
       ORDER BY a.date DESC, a.clock_in DESC LIMIT 200`
    );
  }
  const withNames = r.rows.map(row => ({ ...attendanceWithBreaks(row), user_name: row.user_name }));
  return { status: 200, body: withNames };
});

route('GET', '/admin/leaves', async (pool, { user }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const r = await pool.query(
    `SELECT l.*, u.name AS user_name FROM leaves l JOIN users u ON u.id = l.user_id ORDER BY l.applied_on DESC`
  );
  return { status: 200, body: r.rows };
});

route('GET', '/admin/employee/:id', async (pool, { user, params }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [Number(params.id)]);
  const u = uRes.rows[0];
  if (!u) return { status: 404, body: { error: 'Employee not found' } };

  const attRes = await pool.query('SELECT * FROM attendance WHERE user_id = $1 ORDER BY date DESC LIMIT 60', [u.id]);
  const leaveRes = await pool.query('SELECT * FROM leaves WHERE user_id = $1 ORDER BY applied_on DESC', [u.id]);
  const approved = leaveRes.rows.filter(l => l.status === 'Approved');
  const usedOf = (type) => approved.filter(l => l.leave_type === type).reduce((s, l) => s + Number(l.days), 0);
  const actRes = await pool.query(
    'SELECT * FROM activities WHERE user_id = $1 ORDER BY date DESC, start_time DESC LIMIT 30', [u.id]
  );

  await logAudit(pool, user, 'viewed_employee_details', 'user', u.id, null);
  return {
    status: 200,
    body: {
      profile: findUserPublic(u),
      leave_balance: {
        casual: { total: Number(u.casual_leave_total), used: usedOf('Casual Leave') },
        sick: { total: Number(u.sick_leave_total), used: usedOf('Sick Leave') }
      },
      attendance: attRes.rows.map(attendanceWithBreaks),
      leaves: leaveRes.rows,
      activities: actRes.rows
    }
  };
});

route('POST', '/admin/employee/:id/status', async (pool, { user, params, body }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const { status } = body || {};
  if (!['active', 'inactive'].includes(status)) return { status: 400, body: { error: 'Invalid status' } };
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [Number(params.id)]);
  const u = uRes.rows[0];
  if (!u) return { status: 404, body: { error: 'Employee not found' } };
  if (u.role === 'admin') return { status: 400, body: { error: "Admin accounts can't be deactivated here" } };
  await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, u.id]);
  await logAudit(pool, user, 'employee_status_changed', 'user', u.id, { from: u.status, to: status });
  return { status: 200, body: { ok: true } };
});

route('POST', '/admin/employee/:id/reset-password', async (pool, { user, params, body }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const { new_password } = body || {};
  if (!new_password || new_password.length < 6) return { status: 400, body: { error: 'New password must be at least 6 characters' } };
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [Number(params.id)]);
  const u = uRes.rows[0];
  if (!u) return { status: 404, body: { error: 'Employee not found' } };
  const hash = await hashPassword(new_password);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, u.id]);
  await logAudit(pool, user, 'password_reset_by_admin', 'user', u.id, { email: u.email });
  return { status: 200, body: { ok: true } };
});

route('POST', '/admin/leaves/:id/decision', async (pool, { user, params, body }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const { status, note } = body || {};
  if (!['Approved', 'Rejected'].includes(status)) return { status: 400, body: { error: 'Invalid status' } };
  const lRes = await pool.query('SELECT * FROM leaves WHERE id = $1', [Number(params.id)]);
  const leave = lRes.rows[0];
  if (!leave) return { status: 404, body: { error: 'Leave not found' } };
  if (leave.status !== 'Pending') return { status: 400, body: { error: 'This leave has already been decided' } };
  await pool.query('UPDATE leaves SET status=$1, decided_by=$2, decision_note=$3 WHERE id=$4', [status, user.id, note || null, leave.id]);
  await logAudit(pool, user, 'leave_decision', 'leave', leave.id, { status, note: note || null, employee_id: leave.user_id });
  return { status: 200, body: { ok: true } };
});

route('GET', '/admin/activities', async (pool, { user, query }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const userId = query.user_id, date = query.date, month = query.month;
  const clauses = [];
  const values = [];
  if (userId) { values.push(Number(userId)); clauses.push(`a.user_id = $${values.length}`); }
  if (date) { values.push(date); clauses.push(`a.date = $${values.length}`); }
  else if (month) { values.push(`${month}%`); clauses.push(`a.date::text LIKE $${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT a.*, u.name AS user_name FROM activities a JOIN users u ON u.id = a.user_id
     ${where} ORDER BY a.date DESC, a.start_time DESC`,
    values
  );
  return { status: 200, body: r.rows };
});

route('GET', '/admin/audit-log', async (pool, { user }) => {
  if (!requireAdmin(user)) return { status: 403, body: { error: 'Forbidden: Admin access required' } };
  const r = await pool.query('SELECT * FROM audit ORDER BY id DESC LIMIT 100');
  return { status: 200, body: r.rows };
});

// ---------- routes that don't require a token ----------
const PUBLIC_ROUTES = new Set([
  'GET /setup-status',
  'POST /login',
  'POST /forgot-password/question',
  'POST /forgot-password/reset'
]);

module.exports = async (req, res) => {
  try {
    const pool = getPool();
    const slugParam = req.query.slug;
    const parts = Array.isArray(slugParam) ? slugParam : (slugParam ? [slugParam] : []);
    const pathname = '/' + parts.join('/');
    const method = (req.method || 'GET').toUpperCase();

    const isPublic = PUBLIC_ROUTES.has(`${method} ${pathname}`) || pathname === '/register';

    let user = null;
    if (!isPublic || pathname === '/register') {
      user = readToken(req);
    }
    if (!isPublic && !user) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    // Vercel query params include both the dynamic "slug" segments and
    // any real query-string params (?y=2026&m=09) merged together.
    const query = { ...req.query };
    delete query.slug;

    for (const h of handlers) {
      if (h.method !== method) continue;
      const params = matchPath(h.pattern, parts);
      if (!params) continue;
      const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const result = await h.fn(pool, { user, body, params, query, req });
      res.status(result.status).json(result.body);
      return;
    }
    res.status(404).json({ error: 'Not found' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
};
