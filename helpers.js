// ---------- policy constants (unchanged from the original app) ----------
const REQUIRED_SHIFT_SPAN_MINUTES = 9 * 60; // 8h work + 1h break
const STANDARD_WORK_MINUTES = 8 * 60;
const HALF_DAY_THRESHOLD_MINUTES = 4 * 60;
const LUNCH_BREAK_ALLOWANCE = 60;
const EVENING_BREAK_ALLOWANCE = 30;
const REGULAR_BREAK_ALLOWANCE = LUNCH_BREAK_ALLOWANCE;
const OVERTIME_BREAK_ALLOWANCE = LUNCH_BREAK_ALLOWANCE + EVENING_BREAK_ALLOWANCE;
const BREAK_TYPES = ['lunch', 'evening', 'other'];
const ACTIVITY_STATUSES = ['Completed', 'In Progress', 'Pending', 'On Hold'];

// NOTE ON TIME ZONE: this server computes "today" and "now" using the
// Node process's local time zone. Set a TZ environment variable in your
// Vercel project (e.g. TZ=Asia/Kolkata) so clock-in/out times line up with
// your employees' actual local time — see the deployment README.
const today = () => new Date().toISOString().slice(0, 10);
const nowHHMM = () => {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
};

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function diffMinutes(a, b) {
  return Math.max(0, toMinutes(b) - toMinutes(a));
}
function addMinutesHHMM(hhmm, minsToAdd) {
  const total = ((toMinutes(hhmm) + minsToAdd) % (24 * 60) + 24 * 60) % (24 * 60);
  const h = Math.floor(total / 60).toString().padStart(2, '0');
  const m = (total % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function verifyBiometricScan(id) {
  return typeof id === 'string' && id.trim().length >= 6;
}

function getOpenBreak(breaks) {
  return (breaks || []).find(b => !b.end_time) || null;
}
function breakSummary(breaks) {
  const list = breaks || [];
  const totalMinutes = list.reduce((s, b) => s + (b.duration_minutes || 0), 0);
  return { breaks: list, totalMinutes };
}
// Adds the live break summary/allowance fields onto a raw attendance row,
// same shape the frontend expects (mirrors the old attendanceWithBreaks).
function attendanceWithBreaks(att) {
  if (!att) return null;
  const breaks = att.breaks || [];
  const { totalMinutes } = breakSummary(breaks);
  const allowance = att.shift_type === 'overtime' ? OVERTIME_BREAK_ALLOWANCE : REGULAR_BREAK_ALLOWANCE;
  return {
    ...att,
    breaks,
    break_minutes_live: totalMinutes,
    break_allowance: allowance,
    break_exceeded: totalMinutes > allowance,
    open_break: getOpenBreak(breaks)
  };
}

function findUserPublic(u) {
  if (!u) return u;
  const { password, security_answer_hash, ...rest } = u;
  return rest;
}

async function logAudit(pool, actor, action, targetType, targetId, details) {
  await pool.query(
    `INSERT INTO audit (actor_id, actor_name, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      actor ? actor.id : null,
      actor ? actor.name : 'system',
      action,
      targetType || null,
      targetId || null,
      details ? JSON.stringify(details) : null
    ]
  );
}

module.exports = {
  REQUIRED_SHIFT_SPAN_MINUTES, STANDARD_WORK_MINUTES, HALF_DAY_THRESHOLD_MINUTES,
  REGULAR_BREAK_ALLOWANCE, OVERTIME_BREAK_ALLOWANCE, BREAK_TYPES, ACTIVITY_STATUSES,
  today, nowHHMM, toMinutes, diffMinutes, addMinutesHHMM,
  verifyBiometricScan, getOpenBreak, breakSummary, attendanceWithBreaks,
  findUserPublic, logAudit
};
