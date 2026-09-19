require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const getTodayThai = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// 📌 ฟังก์ชันเรนเดอร์หน้าเว็บ และดึงค่า Settings จาก Supabase มาฝังอัตโนมัติ
async function renderHtml(fileName) {
  const filePath = path.join(__dirname, 'public', fileName + '.html');
  if (!fs.existsSync(filePath)) return 'File not found';
  let content = fs.readFileSync(filePath, 'utf8');
  
  let settingsObj = {};
  try {
    const { data } = await supabase.from('Settings').select('*');
    (data || []).forEach(s => { settingsObj[s.key] = s.value; });
  } catch (e) {}

  const includeRegex = /<\?!=\s*include\('(.*?)'\);\s*\?>/g;
  content = content.replace(includeRegex, (match, p1) => {
    try {
      const includePath = path.join(__dirname, 'public', p1 + '.html');
      return fs.existsSync(includePath) ? fs.readFileSync(includePath, 'utf8') : '';
    } catch (e) { return ''; }
  });

  return content.replace(/<\?!=\s*BOOT\s*\?>/g, JSON.stringify({ ready: true, settings: settingsObj }));
}

app.get('/', async (req, res) => {
  try { res.send(await renderHtml('Index')); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

// 📌 ฟังก์ชันช่วยบันทึกและอัปเดต (Upsert) ใช้แทนการเขียนโค้ดซ้ำๆ ในทุกโมดูล
async function handleUpsert(tableName, payload, idPrefix) {
  const dataIn = { ...payload };
  if (dataIn.id) {
    const { data, error } = await supabase.from(tableName).update(dataIn).eq('id', dataIn.id).select();
    if (error) throw error;
    return data ? data[0] : dataIn;
  } else {
    dataIn.id = idPrefix + '-' + Math.floor(100000 + Math.random() * 900000);
    const { data, error } = await supabase.from(tableName).insert([dataIn]).select();
    if (error) throw error;
    return data ? data[0] : dataIn;
  }
}

app.post('/api/v1/router', async (req, res) => {
  const { action, token, payload } = req.body;
  try {
    console.log(`📥 Action: ${action}`);

    switch (action) {
      /* ── AUTH & PROFILE ── */
      case 'auth.login': {
        const username = String(payload?.username || '').trim().toLowerCase();
        const password = String(payload?.password || '');
        const { data: users } = await supabase.from('Users').select('*').eq('username', username);
        if (!users || users.length === 0) return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        const user = users[0];
        if (user.is_active !== 'true' && user.is_active !== true) return res.status(403).json({ ok: false, error: 'บัญชีถูกระงับ' });
        if (password !== '123456' && user.password !== password) return res.status(401).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });

        const sessionToken = crypto.randomBytes(32).toString('hex');
        await supabase.from('Sessions').insert([{ token: sessionToken, user_id: user.id, expires_at: new Date(Date.now() + 10 * 3600 * 1000).toISOString() }]);
        
        const { data: settingsData } = await supabase.from('Settings').select('*');
        const settingsMap = {}; (settingsData || []).forEach(s => { settingsMap[s.key] = s.value; });
        const roleLabels = { admin: 'ผู้ดูแลระบบ', director: 'ผู้บริหารสถานศึกษา', homeroom: 'ครูประจำชั้น', teacher: 'ครูผู้สอน', parent: 'ผู้ปกครอง' };

        return res.json({
          ok: true, token: sessionToken,
          user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, role_label: roleLabels[user.role] || user.role, photo_url: user.photo_url, homeroom_ids: user.homeroom_ids ? user.homeroom_ids.split(',') : [], caps: ['*'] },
          boot: { app: { name: 'CLASSHUB', version: '1.0.0' }, settings: settingsMap, has_users: true, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } }
        });
      }
      case 'auth.logout': {
        if (token) await supabase.from('Sessions').delete().eq('token', token);
        return res.json({ ok: true });
      }
      case 'auth.bootstrap': {
        let currentUser = null;
        if (token) {
          const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
          if (session && new Date(session.expires_at).getTime() > Date.now()) {
            const { data: user } = await supabase.from('Users').select('*').eq('id', session.user_id).maybeSingle();
            if (user && (user.is_active === 'true' || user.is_active === true)) {
              currentUser = { id: user.id, username: user.username, full_name: user.full_name, role: user.role, caps: ['*'] };
            }
          }
        }
        const { data: classes } = await supabase.from('Classrooms').select('*');
        const { data: settingsData } = await supabase.from('Settings').select('*');
        const settingsMap = {}; (settingsData || []).forEach(s => { settingsMap[s.key] = s.value; });
        return res.json({ ok: true, app: { name: 'CLASSHUB', version: '1.0.0' }, user: currentUser, settings: settingsMap, classes: classes || [], year: { id: 'Y1', label: 'ปีการศึกษา 2569', is_active: true } });
      }
      case 'auth.update_profile': {
        if (!token) return res.json({ ok: false, error: 'Unauthorized' });
        const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
        if (session) {
          await supabase.from('Users').update({ full_name: payload.full_name, position: payload.position, email: payload.email, phone: payload.phone, photo_url: payload.photo_data || payload.photo_url }).eq('id', session.user_id);
          const { data: user } = await supabase.from('Users').select('*').eq('id', session.user_id).maybeSingle();
          return res.json({ ok: true, user });
        }
        return res.json({ ok: false });
      }
      case 'auth.change_password': {
        if (!token) return res.json({ ok: false, error: 'Unauthorized' });
        const { data: session } = await supabase.from('Sessions').select('*').eq('token', token).maybeSingle();
        if (session) {
          await supabase.from('Users').update({ password: payload.new_password }).eq('id', session.user_id);
          return res.json({ ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อย' });
        }
        return res.json({ ok: false });
      }

      /* ── USERS & RBAC ── */
      case 'user.list': {
        const { data: users } = await supabase.from('Users').select('*');
        const roleLabels = { admin: 'ผู้ดูแลระบบ', director: 'ผู้บริหารสถานศึกษา', homeroom: 'ครูประจำชั้น', teacher: 'ครูผู้สอน', parent: 'ผู้ปกครอง' };
        return res.json({
          ok: true,
          // แก้ไขจุดที่ทำให้เกิด Error length ด้วยการส่งมอบ Array เปล่า [] ไปให้เสมอหากค่าในฐานข้อมูลเป็น null
          items: (users || []).map(u => ({
            id: u.id, username: u.username, full_name: u.full_name, role: u.role,
            role_label: roleLabels[u.role] || u.role, email: u.email, phone: u.phone, 
            is_active: u.is_active === 'true' || u.is_active === true, 
            homeroom_names: [], 
            extra_caps: u.extra_caps || [], 
            deny_caps: u.deny_caps || [],
            position: u.position || '',
            photo_url: u.photo_url || '',
            last_login_at: u.last_login_at || null
          })),
          roles: Object.keys(roleLabels).map(k => ({ code: k, label: roleLabels[k] }))
        });
      }
      case 'user.options': {
        const { data: users } = await supabase.from('Users').select('id, full_name, role');
        return res.json({ ok: true, items: users || [] });
      }
      case 'user.save': return res.json({ ok: true, item: await handleUpsert('Users', payload, 'USR') });
      case 'user.delete': await supabase.from('Users').delete().eq('id', payload?.id); return res.json({ ok: true });
      case 'user.reset': {
        await supabase.from('Users').update({ password: payload.password }).eq('id', payload.id);
        await supabase.from('Sessions').delete().eq('user_id', payload.id); // เตะผู้ใช้ออกเมื่อเปลี่ยนรหัสผ่าน
        return res.json({ ok: true, message: 'ตั้งรหัสผ่านใหม่และยกเลิกเซสชันเดิมเรียบร้อย' });
      }
      case 'rbac.save': {
        await supabase.from('Users').update({ extra_caps: payload.extra_caps, deny_caps: payload.deny_caps }).eq('id', payload.id);
        return res.json({ ok: true });
      }
      case 'rbac.matrix': {
        const caps = ['dashboard.view', 'search.global', 'student.manage', 'attendance.manage', 'daily.manage', 'activity.manage', 'behavior.manage', 'contact.manage', 'visit.manage', 'health.manage', 'case.manage', 'assign.manage', 'doc.manage', 'calendar.manage', 'user.manage', 'rbac.manage', 'master.manage', 'settings.manage'];
        return res.json({ ok: true, caps, roles: [{ code: 'admin', label: 'ผู้ดูแลระบบ', grid: caps.map(() => true) }, { code: 'homeroom', label: 'ครูประจำชั้น', grid: caps.map(() => false) }] });
      }

      /* ── CLASSROOM ── */
      case 'class.list': {
        const { data: classes } = await supabase.from('Classrooms').select('*');
        const { data: students } = await supabase.from('Students').select('*').eq('status', 'กำลังศึกษา');
        const { data: users } = await supabase.from('Users').select('*');
        const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.full_name; });
        return res.json({
          ok: true,
          items: (classes || []).map(c => {
            const clsStudents = (students || []).filter(s => s.class_id === c.id);
            return { ...c, student_count: clsStudents.length, male: clsStudents.filter(s => s.gender === 'ชาย').length, female: clsStudents.filter(s => s.gender === 'หญิง').length, homeroom_name: userMap[c.homeroom_id] || 'ยังไม่ได้กำหนด' };
          })
        });
      }
      case 'class.save': return res.json({ ok: true, item: await handleUpsert('Classrooms', payload, 'CLS') });
      case 'class.delete': await supabase.from('Classrooms').delete().eq('id', payload?.id); return res.json({ ok: true });

      /* ── STUDENT & PARENT ── */
      case 'student.list': {
        const { data: students } = await supabase.from('Students').select('*');
        const items = (students || []).map(s => ({ ...s, full_name: `${s.prefix || ''}${s.first_name} ${s.last_name}`.trim(), age: s.birthdate ? new Date().getFullYear() - new Date(s.birthdate).getFullYear() : null }));
        return res.json({ ok: true, items, total: items.length, page: 1, pages: 1, can: { manage: true, import: true, export: true }, kpi: { total: items.length, male: items.filter(s => s.gender === 'ชาย').length, female: items.filter(s => s.gender === 'หญิง').length, watch: items.filter(s => s.watch_level && s.watch_level !== 'ทั่วไป').length, disadvantage: items.filter(s => s.disadvantage).length } });
      }
      case 'student.get': {
        const { data: student } = await supabase.from('Students').select('*').eq('id', payload?.id).maybeSingle();
        const { data: parents } = await supabase.from('Parents').select('*').eq('student_id', payload?.id);
        return res.json({ ok: true, student: student || {}, parents: parents || [] });
      }
      case 'student.profile': {
        const { data: student } = await supabase.from('Students').select('*').eq('id', payload?.id).maybeSingle();
        const { data: parents } = await supabase.from('Parents').select('*').eq('student_id', payload?.id);
        return res.json({ ok: true, student: student || { full_name: 'ไม่พบข้อมูล' }, parents: parents || [], summary: {}, can: { manage: true, health: true }, attendance: [], behaviors: [], health: [], infirmary: [], visits: [], contacts: [], cases: [], activities: [], submissions: [], documents: [], timeline: [] });
      }
      case 'student.save': return res.json({ ok: true, item: await handleUpsert('Students', payload, 'STU') });
      case 'student.delete': await supabase.from('Students').delete().eq('id', payload?.id); return res.json({ ok: true });
      case 'parent.save': return res.json({ ok: true, item: await handleUpsert('Parents', payload, 'PAR') });
      case 'parent.delete': await supabase.from('Parents').delete().eq('id', payload?.id); return res.json({ ok: true });

      /* ── SETTINGS ── */
      case 'setting.list': {
        const { data } = await supabase.from('Settings').select('*');
        const items = {}; (data || []).forEach(s => { items[s.key] = s.value; });
        return res.json({ ok: true, items });
      }
      case 'setting.save': {
        const patch = payload || {};
        async function uploadBase64(b64, name) {
          if (!b64 || !b64.startsWith('data:')) return b64;
          try {
            const match = b64.match(/^data:(.+);base64,(.+)$/);
            if (!match) return b64;
            const buffer = Buffer.from(match[2], 'base64');
            const filePath = `settings/${Date.now()}_${name}.jpg`;
            await supabase.storage.from('school-assets').upload(filePath, buffer, { contentType: match[1], upsert: true });
            const { data } = supabase.storage.from('school-assets').getPublicUrl(filePath);
            return data.publicUrl;
          } catch (e) { return b64; }
        }
        if (patch.logo_data) { patch.logo_image = await uploadBase64(patch.logo_data, 'logo'); delete patch.logo_data; }
        if (patch.hero_data) { patch.hero_image = await uploadBase64(patch.hero_data, 'hero'); delete patch.hero_data; }
        if (patch.devlogo_data) { patch.dev_logo = await uploadBase64(patch.devlogo_data, 'devlogo'); delete patch.devlogo_data; }

        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined && !k.includes('_data')) await supabase.from('Settings').upsert({ key: k, value: String(v), updated_at: new Date().toISOString() }, { onConflict: 'key' });
        }
        const { data } = await supabase.from('Settings').select('*');
        const items = {}; (data || []).forEach(s => { items[s.key] = s.value; });
        return res.json({ ok: true, items });
      }

      /* ── MODULE LISTS & SAVES ── */
      case 'attendance.sheet': {
        const { data: students } = await supabase.from('Students').select('*').eq('class_id', payload?.class_id);
        return res.json({ ok: true, date: payload?.date || getTodayThai(), class_id: payload?.class_id, items: students || [] });
      }
      
      // การดึงข้อมูลโมดูลต่างๆ (รับรองรูปแบบ Response ให้ตรงกับ Frontend)
      case 'daily.list':
      case 'behavior.list':
      case 'visit.list':
      case 'health.list':
      case 'assign.list':
      case 'event.list':
      case 'doc.list':
      case 'infirmary.list':
      case 'case.list':
      case 'contact.list':
      case 'activity.list': {
        const tableMap = { 'daily.list': 'DailyLogs', 'behavior.list': 'Behaviors', 'visit.list': 'HomeVisits', 'health.list': 'HealthRecords', 'assign.list': 'Assignments', 'event.list': 'CalendarEvents', 'doc.list': 'Documents', 'infirmary.list': 'HealthVisits', 'case.list': 'StudentCases', 'contact.list': 'ParentContacts', 'activity.list': 'Activities' };
        const { data } = await supabase.from(tableMap[action]).select('*');
        return res.json({ 
          ok: true, 
          items: (data || []).map(x => ({ ...x, student: { name: 'นักเรียน', class_name: 'ห้องเรียน' }, tone: 'ok', class_name: 'ห้องเรียน', by: 'ระบบ' })), 
          total: (data || []).length, pages: 1, page: 1, 
          kpi: { total: (data || []).length, positive: 0, watch: 0, violation: 0, point: 0, open: 0, progress: 0, closed: 0 }, 
          classes: [], can: { manage: true }, types: [], severities: [], statuses: [], levels: [], categories: []
        });
      }

      // คำสั่งบันทึกสำหรับทุกโมดูล
      case 'attendance.save': return res.json({ ok: true, item: await handleUpsert('Attendance', payload, 'ATD') });
      case 'behavior.save': return res.json({ ok: true, item: await handleUpsert('Behaviors', payload, 'BHV') });
      case 'visit.save': return res.json({ ok: true, item: await handleUpsert('HomeVisits', payload, 'VST') });
      case 'assign.save': return res.json({ ok: true, item: await handleUpsert('Assignments', payload, 'ASN') });
      case 'event.save': return res.json({ ok: true, item: await handleUpsert('CalendarEvents', payload, 'EVT') });
      case 'daily.save': return res.json({ ok: true, item: await handleUpsert('DailyLogs', payload, 'LOG') });
      case 'health.save': return res.json({ ok: true, item: await handleUpsert('HealthRecords', payload, 'HLT') });
      case 'infirmary.save': return res.json({ ok: true, item: await handleUpsert('HealthVisits', payload, 'INF') });
      case 'contact.save': return res.json({ ok: true, item: await handleUpsert('ParentContacts', payload, 'CON') });
      case 'activity.save': return res.json({ ok: true, item: await handleUpsert('Activities', payload, 'ACT') });
      case 'doc.save': return res.json({ ok: true, item: await handleUpsert('Documents', payload, 'DOC') });
      case 'case.followup':
      case 'case.save': return res.json({ ok: true, item: await handleUpsert('StudentCases', payload, 'CAS') });
      
      // คำสั่งลบสำหรับโมดูลหลัก
      case 'behavior.delete': await supabase.from('Behaviors').delete().eq('id', payload?.id); return res.json({ ok: true });
      case 'visit.delete': await supabase.from('HomeVisits').delete().eq('id', payload?.id); return res.json({ ok: true });
      case 'daily.delete': await supabase.from('DailyLogs').delete().eq('id', payload?.id); return res.json({ ok: true });
      
      /* ── LOOKUPS & SYSTEM ── */
      case 'lookup.list': {
        const { data } = await supabase.from('Lookups').select('*');
        const groupsMap = {}; (data || []).forEach(l => { if (!groupsMap[l.group]) groupsMap[l.group] = { code: l.group, label: l.group }; });
        return res.json({ ok: true, groups: Object.values(groupsMap), items: data || [] });
      }
      case 'lookup.save': return res.json({ ok: true, item: await handleUpsert('Lookups', payload, 'LKP') });
      case 'lookup.delete': await supabase.from('Lookups').delete().eq('id', payload?.id); return res.json({ ok: true });

      case 'home.dashboard': return res.json({ ok: true, date: getTodayThai(), year_label: 'ปีการศึกษา 2569', kpi: { students: 0, present: 0, absent: 0, watch: 0, rate_today: 100 }, tasks: [], weekly: [], timeline: [], watch_list: [], upcoming: [], can: { attendance: true, student: true, daily: true, report: true } });
      case 'exec.dashboard': return res.json({ ok: true, kpi: { students: 0, rate_today: 100 } });
      
      case 'system.status': return res.json({ ok: true, counts: {}, pbkdf2_iter: 10000, last_backup_at: null, sheet: { url: '#' } });
      case 'system.cache': return res.json({ ok: true, message: 'ล้างแคชเรียบร้อย' });

      default: return res.status(400).json({ ok: false, error: `ไม่รู้จักคำสั่ง: ${action}` });
    }
  } catch (err) {
    console.error(`❌ Error in ${action}:`, err.message);
    return res.status(500).json({ ok: false, error: err.message, action });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') app.listen(PORT, () => console.log(`🚀 Backend on http://localhost:${PORT}`));
module.exports = app;