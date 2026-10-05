const KEY = 'careconnect_data_v6';
const SESSION_KEY = 'careconnect_session';

let state = {
  page: 'dashboard',
  search: '',
  filter: 'All',
  chat: [],
  activeCall: null,
  callStream: null,
  callAudioOn: true,
  callVideoOn: true
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function db() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {users:[], doctors:[], appointments:[], notifications:[]};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid stored data');
    return parsed;
  } catch (error) {
    console.error('CareConnect data read failed:', error);
    return {users:[], doctors:[], appointments:[], notifications:[]};
  }
}

function save(data) {
  try {
    const payload = JSON.stringify(data);
    localStorage.setItem(KEY, payload);
    const check = localStorage.getItem(KEY);
    if (check !== payload) throw new Error('Local Storage verification failed');
    return true;
  } catch (error) {
    console.error('CareConnect save failed:', error);
    showToast('Could not save changes. Please check browser storage permissions.');
    return false;
  }
}

function commitData(data, message) {
  const normalized = normalizeData(data);
  if (!save(normalized)) return false;
  // Verify the exact record is still present after writing.
  const verify = db();
  if (!verify || !Array.isArray(verify.users) || !Array.isArray(verify.doctors) || !Array.isArray(verify.appointments)) {
    showToast('Save verification failed. Please try again.');
    return false;
  }
  closeModal();
  render();
  showToast(message);
  return true;
}

function session() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('Resetting invalid CareConnect session:', error);
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
}

function roleLabel(role) {
  return role === 'admin' ? 'Administrator' : role === 'doctor' ? 'Doctor portal' : 'Patient portal';
}

function showToast(message) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', {
    day:'numeric', month:'short', year:'numeric'
  });
}

function snapshotPatient(user) {
  return {
    name: user.name || '', email: user.email || '', phone: user.phone || '', age: user.age || '',
    gender: user.gender || '', bloodGroup: user.bloodGroup || '', address: user.address || '',
    emergencyContact: user.emergencyContact || '', changedAt: new Date().toISOString()
  };
}

function ensurePatientDefaults(user) {
  user.profileHistory = Array.isArray(user.profileHistory) ? user.profileHistory : [];
  user.age = user.age ?? '';
  user.gender = user.gender ?? '';
  user.bloodGroup = user.bloodGroup ?? '';
  user.address = user.address ?? '';
  user.emergencyContact = user.emergencyContact ?? '';
}

function createNotification(data, userId, title, message, type='info', key='') {
  if (!userId) return;
  data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
  if (key && data.notifications.some(n => n.userId === userId && n.key === key)) return;
  data.notifications.push({
    id: uid('n'), userId, title, message, type,
    key, read:false, createdAt:new Date().toISOString()
  });
}

function syncNotifications(data) {
  data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
  data.appointments = Array.isArray(data.appointments) ? data.appointments : [];
  data.doctors = Array.isArray(data.doctors) ? data.doctors : [];
  for (const a of data.appointments) {
    if (a.status !== 'Confirmed') continue;
    const doctor = data.doctors.find(d => d.id === a.doctorId);
    if (!doctor || doctor.available !== false) continue;
    const patient = data.users.find(u => u.id === a.patientId);
    if (!patient) continue;
    const key = `doctor-unavailable:${a.id}:${doctor.updatedAt || doctor.availableSince || 'v1'}`;
    createNotification(
      data,
      patient.id,
      `Doctor unavailable — ${doctor.name}`,
      `Your ${a.mode === 'online' ? 'online consultation' : 'offline visit'} on ${formatDate(a.date)} at ${a.time} is affected because Dr. ${doctor.name} is currently marked unavailable. Please choose another slot or doctor.`,
      'warning', key
    );
  }
}

function normalizeData(data) {
  data.users = Array.isArray(data.users) ? data.users : [];
  data.doctors = Array.isArray(data.doctors) ? data.doctors : [];
  data.appointments = Array.isArray(data.appointments) ? data.appointments : [];
  data.notifications = Array.isArray(data.notifications) ? data.notifications : [];

  let admin = data.users.find(u => u.role === 'admin' || u.id === 'admin-1');
  if (!admin) {
    admin = { id:'admin-1', name:'CareConnect Admin', email:'syed@gmail.com', password:'Syed@7866', phone:'0000000000', role:'admin' };
    data.users.unshift(admin);
  }
  Object.assign(admin, {
    id:'admin-1', name:'CareConnect Admin', email:'syed@gmail.com', password:'Syed@7866', role:'admin'
  });

  // Ensure all doctors have a usable availability state and a linked doctor login.
  data.doctors.forEach((doctor, index) => {
    doctor.available = doctor.available !== false;
    doctor.availability = doctor.availability || 'Mon, Wed, Fri';
    doctor.slots = Array.isArray(doctor.slots) && doctor.slots.length ? doctor.slots : ['09:00','11:00','16:00'];
    doctor.fee = Number(doctor.fee || 500);
    doctor.specialty = doctor.specialty || 'General Physician';
    doctor.experience = doctor.experience || 'Experienced practitioner';
    doctor.ratingCount = Number.isFinite(Number(doctor.ratingCount)) ? Number(doctor.ratingCount) : 0;
    doctor.ratingSum = Number.isFinite(Number(doctor.ratingSum)) ? Number(doctor.ratingSum) : 0;
    if (doctor.updatedAt == null) doctor.updatedAt = new Date().toISOString();

    let doctorUser = data.users.find(u => u.role === 'doctor' && u.doctorId === doctor.id);
    if (!doctorUser) {
      doctorUser = {
        id:`doctor-user-${doctor.id}`,
        name:doctor.name,
        email:`${doctor.name.toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'')}@careconnect.demo`,
        password:`Doctor@${1000 + index}`,
        phone:'0000000000', role:'doctor', doctorId:doctor.id
      };
      data.users.push(doctorUser);
    }
    doctorUser.name = doctor.name;
    doctorUser.doctorId = doctor.id;
    doctorUser.role = 'doctor';
  });

  // Requested demo doctor credentials.
  let ramesh = data.doctors.find(d => d.id === 'd1');
  if (!ramesh) {
    ramesh = {
      id:'d1', name:'Ramesh Kumar', specialty:'General Physician', experience:'10 years', fee:500,
      availability:'Mon, Wed, Fri', slots:['09:00','10:00','11:00','16:00'], available:true,
      updatedAt:new Date().toISOString()
    };
    data.doctors.unshift(ramesh);
  }
  ramesh.name = 'Ramesh Kumar';
  ramesh.specialty = ramesh.specialty || 'General Physician';
  ramesh.available = ramesh.available !== false;
  let rameshUser = data.users.find(u => u.role === 'doctor' && u.doctorId === 'd1');
  if (!rameshUser) {
    rameshUser = {id:'doctor-user-d1', name:'Ramesh Kumar', email:'ramesh@gmail.com', password:'2007', phone:'0000000000', role:'doctor', doctorId:'d1'};
    data.users.push(rameshUser);
  }
  Object.assign(rameshUser, {name:'Ramesh Kumar', email:'ramesh@gmail.com', password:'2007', role:'doctor', doctorId:'d1'});

  data.users.filter(u => u.role === 'patient').forEach(ensurePatientDefaults);

  // Upgrade old appointments to the richer appointment model.
  for (const a of data.appointments) {
    a.mode = a.mode === 'online' ? 'online' : 'offline';
    a.chat = Array.isArray(a.chat) ? a.chat : [];
    if (a.mode === 'offline' && !a.tokenNumber) {
      a.tokenNumber = nextOfflineToken(data, a.doctorId, a.date, a.id);
    }
  }

  syncNotifications(data);
  data.version = 4;
  return data;
}

function safeParseRaw(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (error) { console.warn('Ignoring invalid stored data:', error); return null; }
}

function seedData() {
  let current = safeParseRaw(localStorage.getItem(KEY));
  if (!current) {
    const old = safeParseRaw(
      localStorage.getItem('careconnect_data_v5') ||
      localStorage.getItem('careconnect_data_v4') ||
      localStorage.getItem('careconnect_data_v3') ||
      localStorage.getItem('careconnect_data_v2') ||
      localStorage.getItem('careconnect_data_v1')
    );
    if (old && Array.isArray(old.users) && Array.isArray(old.doctors)) {
      current = {
        users: old.users.map(u => ({...u})),
        doctors: old.doctors.map(d => ({...d})),
        appointments: Array.isArray(old.appointments) ? old.appointments.map(a => ({...a})) : [],
        notifications: Array.isArray(old.notifications) ? old.notifications.map(n => ({...n})) : []
      };
    }
  }

  if (!current) {
    current = {
      users: [
        {id:'admin-1',name:'CareConnect Admin',email:'syed@gmail.com',password:'Syed@7866',phone:'0000000000',role:'admin'},
        {id:'doctor-user-d1',name:'Ramesh Kumar',email:'ramesh@gmail.com',password:'2007',phone:'0000000000',role:'doctor',doctorId:'d1'},
        {id:'doctor-user-d2',name:'Rahul Mehta',email:'rahul.mehta@careconnect.demo',password:'Doctor@1001',phone:'0000000000',role:'doctor',doctorId:'d2'},
        {id:'doctor-user-d3',name:'Priya Nair',email:'priya.nair@careconnect.demo',password:'Doctor@1002',phone:'0000000000',role:'doctor',doctorId:'d3'},
        {id:'doctor-user-d4',name:'Vikram Singh',email:'vikram.singh@careconnect.demo',password:'Doctor@1003',phone:'0000000000',role:'doctor',doctorId:'d4'}
      ],
      doctors: [
        {id:'d1',name:'Ramesh Kumar',specialty:'General Physician',experience:'10 years',fee:500,availability:'Mon, Wed, Fri',slots:['09:00','10:00','11:00','16:00'],available:true,updatedAt:new Date().toISOString()},
        {id:'d2',name:'Rahul Mehta',specialty:'Dermatologist',experience:'8 years',fee:500,availability:'Tue, Thu, Sat',slots:['10:00','11:30','14:00','17:00'],available:true,updatedAt:new Date().toISOString()},
        {id:'d3',name:'Priya Nair',specialty:'Pediatrician',experience:'10 years',fee:600,availability:'Mon, Tue, Thu',slots:['09:30','11:00','15:00','17:30'],available:true,updatedAt:new Date().toISOString()},
        {id:'d4',name:'Vikram Singh',specialty:'Orthopedic',experience:'15 years',fee:800,availability:'Wed, Fri, Sat',slots:['09:00','12:00','15:30','18:00'],available:true,updatedAt:new Date().toISOString()}
      ],
      appointments:[],
      notifications:[],
      version:4
    };
  }
  current = normalizeData(current);
  save(current);
  const active = session();
  if (active && !current.users.some(u => u.id === active.id)) localStorage.removeItem(SESSION_KEY);
}

function nextOfflineToken(data, doctorId, date, ignoreId='') {
  const used = data.appointments
    .filter(a => a.doctorId === doctorId && a.date === date && a.mode === 'offline' && a.status !== 'Cancelled' && a.id !== ignoreId)
    .map(a => Number(a.tokenNumber) || 0)
    .filter(Boolean);
  return used.length ? Math.max(...used) + 1 : 1;
}

function getDoctor(data, doctorId) {
  return data.doctors.find(d => d.id === doctorId);
}

// --- Ratings ---------------------------------------------------------
function ratingAvg(doctor) {
  const count = Number(doctor?.ratingCount) || 0;
  if (!count) return null;
  return (Number(doctor.ratingSum) || 0) / count;
}

function starGlyphs(value) {
  const rounded = Math.max(0, Math.min(5, Math.round(value)));
  return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
}

function ratingBadgeHTML(doctor) {
  const avg = ratingAvg(doctor);
  const count = Number(doctor.ratingCount) || 0;
  if (avg == null) return `<div class="doctor-rating no-rating"><span class="stars">☆☆☆☆☆</span> No ratings yet</div>`;
  return `<div class="doctor-rating"><span class="stars">${starGlyphs(avg)}</span> ${avg.toFixed(1)} <small>(${count} rating${count===1?'':'s'})</small></div>`;
}

function submitRating(appointmentId, stars, comment) {
  stars = Number(stars);
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    showToast('Please choose a star rating from 1 to 5.');
    return false;
  }
  const d = normalizeData(db());
  const a = d.appointments.find(x => x.id === appointmentId);
  if (!a) { showToast('Appointment not found.'); return false; }
  const doctor = getDoctor(d, a.doctorId);
  if (!doctor) { showToast('Doctor record not found.'); return false; }

  const alreadyRated = a.rating && Number.isFinite(Number(a.rating.stars));
  const previousStars = alreadyRated ? Number(a.rating.stars) : 0;

  a.rating = { stars, comment: String(comment || '').trim(), ratedAt: new Date().toISOString() };

  if (alreadyRated) {
    doctor.ratingSum = (Number(doctor.ratingSum) || 0) - previousStars + stars;
  } else {
    doctor.ratingSum = (Number(doctor.ratingSum) || 0) + stars;
    doctor.ratingCount = (Number(doctor.ratingCount) || 0) + 1;
  }

  return commitData(d, alreadyRated ? 'Your rating has been updated. Thank you!' : 'Thanks for rating your doctor!');
}

function rateModal(appointmentId) {
  const d = db();
  const a = d.appointments.find(x => x.id === appointmentId);
  if (!a) return showToast('Appointment not found.');
  const doctor = getDoctor(d, a.doctorId);
  const existingStars = a.rating ? Number(a.rating.stars) || 0 : 0;
  const existingComment = a.rating ? a.rating.comment || '' : '';
  openModal(`<h2>Rate Dr. ${esc(doctor?.name || 'your doctor')}</h2><p>Your rating helps other patients find well-reviewed doctors. Only ratings decide how doctors are suggested.</p>
    <form id="ratingForm">
      <input type="hidden" name="appointmentId" value="${esc(appointmentId)}">
      <input type="hidden" name="stars" value="${existingStars}">
      <div class="star-picker" data-star-picker>${[1,2,3,4,5].map(n => `<button type="button" class="star-btn ${n <= existingStars ? 'filled' : ''}" data-star="${n}" aria-label="${n} star${n>1?'s':''}">★</button>`).join('')}</div>
      <label class="field full">Comment (optional)<textarea name="comment" rows="3" placeholder="How was your consultation?">${esc(existingComment)}</textarea></label>
      <div class="modal-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button type="button" class="primary-btn" data-submit-rating>Submit rating</button></div>
    </form>`);
}

function getUnreadCount(userId) {
  return db().notifications.filter(n => n.userId === userId && !n.read).length;
}

function setAuth(mode) {
  document.getElementById('loginForm').classList.toggle('hidden', mode === 'signup');
  document.getElementById('signupForm').classList.toggle('hidden', mode !== 'signup');
  document.getElementById('authTitle').textContent = mode === 'signup' ? 'Create your CareConnect account' : 'Welcome back';
  document.getElementById('authSubtitle').textContent = mode === 'signup'
    ? 'Choose Patient or Doctor during signup. Admin access is kept separate.'
    : 'Sign in as a Patient, Doctor, or Admin.';
  window.scrollTo({top:0, behavior:'smooth'});
}

function appointmentHTML(a, doctor, extra='') {
  const mode = a.mode === 'online' ? 'Online video' : `Offline · Token #${a.tokenNumber || '-'}`;
  const statusClass = String(a.status).toLowerCase();
  return `<div class="appointment-row">
    <div class="date-badge"><small>${new Date(`${a.date}T12:00:00`).toLocaleString('en',{month:'short'}).toUpperCase()}</small><strong>${new Date(`${a.date}T12:00:00`).getDate()}</strong></div>
    <div>
      <h4>Dr. ${esc(doctor?.name || 'Removed doctor')}</h4>
      <p>${esc(doctor?.specialty || '')} · ${esc(a.time)} · ${esc(a.reason || 'General consultation')}</p>
      <div class="appointment-tags"><span>${mode}</span>${a.patientName ? `<span>Patient: ${esc(a.patientName)}</span>` : ''}</div>
    </div>
    <span class="status ${statusClass}">${esc(a.status)}</span>
    ${extra}
  </div>`;
}

function render() {
  const data = normalizeData(db());
  syncNotifications(data);
  save(data);

  const user = session();
  document.getElementById('authView').classList.toggle('hidden', !!user);
  document.getElementById('appView').classList.toggle('hidden', !user);
  if (!user) return;

  const unread = getUnreadCount(user.id);
  const doctor = user.role === 'doctor' ? getDoctor(data, user.doctorId) : null;
  document.getElementById('sidebarName').textContent = user.name;
  document.getElementById('sidebarRole').textContent = roleLabel(user.role);
  document.getElementById('avatar').textContent = user.name?.[0]?.toUpperCase() || 'U';
  document.getElementById('topAvatar').textContent = user.name?.[0]?.toUpperCase() || 'U';
  document.getElementById('todayDate').textContent = new Date().toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
  const bell = document.getElementById('notificationBtn');
  if (bell) bell.innerHTML = `🔔 Notifications ${unread ? `<span class="notif-count">${unread}</span>` : ''}`;

  let items;
  if (user.role === 'admin') {
    items = [['dashboard','▦','Overview'],['appointments','▣','Appointments'],['doctors','♟','Manage doctors'],['patients','♧','Patients'],['notifications','🔔','Notifications'],['assistant','✦','AI Assistant']];
  } else if (user.role === 'doctor') {
    items = [['dashboard','▦','Dashboard'],['appointments','▣','Appointments'],['availability','◷','My availability'],['notifications','🔔','Notifications'],['assistant','✦','AI Assistant']];
  } else {
    items = [['dashboard','▦','Dashboard'],['doctors','♟','Find a doctor'],['appointments','▣','My appointments'],['history','◷','Appointment history'],['notifications','🔔','Notifications'],['assistant','✦','AI Assistant']];
  }

  document.getElementById('sideNav').innerHTML = items.map(x =>
    `<button data-page="${x[0]}" class="${state.page === x[0] ? 'active' : ''}"><span>${x[1]}</span>${x[2]}</button>`
  ).join('');

  const titleMap = {
    dashboard:'Dashboard', appointments:user.role === 'admin' ? 'All appointments' : 'Appointments',
    doctors:user.role === 'admin' ? 'Doctor management' : 'Find a doctor', patients:'Patients',
    history:'Appointment history', availability:'My availability', notifications:'Notifications', assistant:'CareConnect AI Assistant'
  };
  document.getElementById('pageTitle').textContent = titleMap[state.page] || 'Dashboard';
  document.getElementById('pageKicker').textContent = user.role === 'admin' ? 'ADMIN PORTAL' : user.role === 'doctor' ? 'DOCTOR PORTAL' : 'PATIENT PORTAL';
  document.getElementById('pageContent').innerHTML = user.role === 'admin' ? adminPage() : user.role === 'doctor' ? doctorPage(doctor) : patientPage();

  if (state.page === 'assistant') setTimeout(renderChat, 0);
}

function appointmentActions(a, context) {
  let out = '';
  if (context === 'patient' && a.status === 'Confirmed') {
    out += `<div class="row-actions"><button class="action-btn" data-edit="${a.id}">Reschedule</button><button class="action-btn danger" data-cancel="${a.id}">Cancel</button>`;
    if (a.mode === 'online') out += `<button class="action-btn call-btn" data-video-call="${a.id}">Join video</button>`;
    out += `</div>`;
  }
  if (context === 'doctor' && a.status === 'Confirmed') {
    if (a.mode === 'online') out += `<button class="action-btn call-btn" data-video-call="${a.id}">Join video</button>`;
    out += `<div class="row-actions"><button class="action-btn" data-complete="${a.id}">Mark complete</button><button class="action-btn danger" data-cancel="${a.id}">Cancel</button></div>`;
  }
  if (context === 'patient' && a.status === 'Completed') {
    if (a.rating && Number.isFinite(Number(a.rating.stars))) {
      out += `<div class="row-actions"><span class="rating-given"><span class="stars">${starGlyphs(a.rating.stars)}</span> Your rating<button class="link-btn" data-rate="${a.id}">Edit</button></span></div>`;
    } else {
      out += `<div class="row-actions"><button class="action-btn rate-btn" data-rate="${a.id}">⭐ Rate this doctor</button></div>`;
    }
  }
  return out;
}

function patientPage() {
  const d = db(), u = session();
  const mine = d.appointments.filter(a => a.patientId === u.id);
  const upcoming = mine.filter(a => a.status === 'Confirmed' && a.date >= todayISO());

  if (state.page === 'dashboard') {
    const alertCount = d.notifications.filter(n => n.userId === u.id && !n.read && n.type === 'warning').length;
    const upcomingHtml = upcoming.length
      ? upcoming.sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).map(a => {
          const doctor = d.doctors.find(x=>x.id===a.doctorId);
          const join = a.mode === 'online' ? `<button class="action-btn call-btn" data-video-call="${a.id}">Join video</button>` : '';
          return appointmentHTML(a, doctor, join);
        }).join('')
      : '<div class="empty">No appointments booked yet. Find a doctor to get started.</div>';
    return `<div class="content">
      <div class="welcome-row"><div><h1>Hello, ${esc(u.name.split(' ')[0])}.</h1><p>Manage appointments, choose online/offline visits, and get help from CareConnect AI.</p></div><button class="primary-btn" data-action="book-first">Book an appointment →</button></div>
      ${alertCount ? `<div class="notice-banner warning"><strong>⚠ ${alertCount} appointment alert${alertCount>1?'s':''}</strong><span>A booked doctor is currently unavailable. Check Notifications for details.</span><button class="link-btn" data-page="notifications">View alerts →</button></div>` : ''}
      <div class="stats-grid"><div class="stat"><span class="stat-icon">▣</span><b>${upcoming.length}</b><span>Upcoming appointments</span></div><div class="stat"><span class="stat-icon">✓</span><b>${mine.filter(a=>a.status==='Completed').length}</b><span>Completed visits</span></div><div class="stat"><span class="stat-icon">♟</span><b>${d.doctors.filter(x=>x.available!==false).length}</b><span>Doctors available</span></div></div>
      <div class="mode-info-grid"><div class="mode-card"><b>💻 Online consultation</b><span>Join a browser video room with mic, camera controls and chat.</span></div><div class="mode-card"><b>🏥 Offline visit</b><span>Get a token number while booking so your turn is tracked.</span></div></div>
      <div class="assistant-teaser"><div><span class="ai-badge">✦ AI</span><h3>CareConnect AI Assistant</h3><p>Ask naturally about a medicine, tablet, symptom, doctor, token, online visit, or appointment.</p></div><button class="secondary-btn" data-page="assistant">Open AI Assistant →</button></div>
      <div class="section-head"><h3>Upcoming appointments</h3><button class="link-btn" data-page="appointments">View all →</button></div>
      <div class="card">${upcomingHtml}</div>
    </div>`;
  }

  if (state.page === 'doctors') return doctorsPage(false);
  if (state.page === 'assistant') return assistantPage();
  if (state.page === 'notifications') return notificationsPage(u);

  const list = state.page === 'history' ? mine.filter(a => a.status !== 'Confirmed') : mine;
  const rows = list.length
    ? list.sort((a,b)=>`${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)).map(a => appointmentHTML(a, d.doctors.find(x=>x.id===a.doctorId), appointmentActions(a,'patient'))).join('')
    : '<div class="empty">Nothing to show here yet.</div>';
  return `<div class="content"><div class="section-head"><h3>${state.page==='history'?'Past and cancelled appointments':'Manage your bookings'}</h3>${state.page==='appointments'?'<button class="primary-btn" data-action="book-first">Book appointment →</button>':''}</div><div class="card">${rows}</div></div>`;
}

function doctorsPage(admin) {
  const d = db();
  const specs = [...new Set(d.doctors.map(x=>x.specialty))];
  const filtered = d.doctors.filter(x =>
    (!state.search || `${x.name} ${x.specialty}`.toLowerCase().includes(state.search.toLowerCase())) &&
    (state.filter === 'All' || x.specialty === state.filter)
  ).sort((a, b) => {
    // Recommend doctors to patients using ratings only: highest average first.
    const avgA = ratingAvg(a); const avgB = ratingAvg(b);
    if (avgA == null && avgB == null) return a.name.localeCompare(b.name);
    if (avgA == null) return 1;
    if (avgB == null) return -1;
    if (avgB !== avgA) return avgB - avgA;
    return (b.ratingCount||0) - (a.ratingCount||0);
  });
  const topRatedId = !admin && filtered[0] && ratingAvg(filtered[0]) != null ? filtered[0].id : null;
  const cards = filtered.length
    ? filtered.map(x => {
        const unavailable = x.available === false;
        let action = '';
        if (admin) {
          action = `<button class="secondary-btn" data-editdoctor="${x.id}">Edit doctor</button><button class="action-btn" data-toggle-doctor="${x.id}">${unavailable?'Set available':'Set unavailable'}</button><button class="action-btn danger" data-deletedoctor="${x.id}">Remove</button>`;
        } else {
          action = `<button class="primary-btn" data-book="${x.id}" ${unavailable?'disabled':''}>${unavailable?'Doctor unavailable':'Book appointment'}</button>`;
        }
        return `<article class="doctor-card ${unavailable?'doctor-unavailable':''}"><div class="doctor-head"><div class="doctor-icon">🩺</div><div><h3>Dr. ${esc(x.name)}</h3><p>${esc(x.specialty)}</p></div>${x.id===topRatedId?'<span class="top-badge">🏆 Top rated</span>':''}</div><div class="doctor-status ${unavailable?'offline':'online'}">● ${unavailable?'Currently unavailable':'Available for booking'}</div>${ratingBadgeHTML(x)}<div class="doctor-meta">${esc(x.experience)} experience<br>Available: ${esc(x.availability)}<br>Slots: ${esc(x.slots.join(', '))}<br><strong>₹${esc(x.fee)} consultation</strong></div>${action}</article>`;
      }).join('')
    : '<div class="empty">No doctors match your search.</div>';
  return `<div class="content"><div class="toolbar"><input class="search-input" data-search placeholder="Search by doctor or specialization" value="${esc(state.search)}"><select class="filter-select" data-filter><option>All</option>${specs.map(s=>`<option ${state.filter===s?'selected':''}>${esc(s)}</option>`).join('')}</select>${admin?'<button class="primary-btn" data-action="add-doctor">+ Add doctor</button>':''}</div>${!admin?'<p class="rating-note">Doctors are ordered by patient ratings — the best-reviewed doctors are suggested first.</p>':''}<div class="doctors-grid">${cards}</div></div>`;
}

function doctorPage(doctor) {
  const d = db();
  if (!doctor) return '<div class="content"><div class="empty">Doctor profile not found.</div></div>';
  const mine = d.appointments.filter(a=>a.doctorId===doctor.id).sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  if (state.page === 'availability') {
    return `<div class="content"><div class="welcome-row"><div><h1>My availability</h1><p>Patients see this status and schedule when booking.</p></div><button class="primary-btn" data-editdoctor="${doctor.id}">Edit schedule →</button></div><div class="card availability-card"><div><span class="ai-badge">DOCTOR PROFILE</span><h3>Dr. ${esc(doctor.name)}</h3><p>${esc(doctor.specialty)} · ${esc(doctor.experience)}</p></div><div class="availability-box"><strong>Current status</strong><span class="doctor-status ${doctor.available===false?'offline':'online'}">● ${doctor.available===false?'Unavailable':'Available for booking'}</span><button class="secondary-btn" data-toggle-self="${doctor.id}">${doctor.available===false?'Mark available':'Mark unavailable'}</button></div><div class="availability-box"><strong>Available days</strong><span>${esc(doctor.availability)}</span></div><div class="availability-box"><strong>Appointment slots</strong><span>${doctor.slots.map(esc).join(' · ')}</span></div></div></div>`;
  }
  if (state.page === 'assistant') return assistantPage();
  if (state.page === 'notifications') return notificationsPage(session());
  if (state.page === 'dashboard') {
    const today = mine.filter(a=>a.date===todayISO() && a.status==='Confirmed').length;
    const upcomingHtml = mine.filter(a=>a.status==='Confirmed'&&a.date>=todayISO()).slice(0,5).map(a=>appointmentHTML(a,doctor,appointmentActions(a,'doctor'))).join('') || '<div class="empty">No upcoming appointments.</div>';
    return `<div class="content"><div class="welcome-row"><div><h1>Good day, Dr. ${esc(doctor.name.split(' ')[0])}.</h1><p>Manage your schedule, appointments and online consultations.</p></div><button class="primary-btn" data-page="availability">Update availability →</button></div><div class="stats-grid"><div class="stat"><span class="stat-icon">▣</span><b>${today}</b><span>Appointments today</span></div><div class="stat"><span class="stat-icon">✓</span><b>${mine.filter(a=>a.status==='Completed').length}</b><span>Completed visits</span></div><div class="stat"><span class="stat-icon">♟</span><b>${mine.filter(a=>a.status==='Confirmed').length}</b><span>Confirmed appointments</span></div></div><div class="mode-info-grid"><div class="mode-card"><b>💻 Online</b><span>Join video consultations and use appointment chat.</span></div><div class="mode-card"><b>🏥 Offline</b><span>See each patient's token number and visit reason.</span></div></div><div class="assistant-teaser"><div><span class="ai-badge">✦ AI</span><h3>CareConnect AI Assistant</h3><p>Use the assistant for appointment workflows and general healthcare information.</p></div><button class="secondary-btn" data-page="assistant">Open AI Assistant →</button></div><div class="section-head"><h3>Upcoming appointments</h3><button class="link-btn" data-page="appointments">View all →</button></div><div class="card">${upcomingHtml}</div></div>`;
  }
  const rows=mine.length ? mine.map(a=>appointmentHTML(a,doctor,appointmentActions(a,'doctor'))).join('') : '<div class="empty">No appointments assigned yet.</div>';
  return `<div class="content"><div class="section-head"><h3>My patient appointments</h3></div><div class="card">${rows}</div></div>`;
}

function adminPage() {
  const d = db();
  if (state.page === 'assistant') return assistantPage();
  if (state.page === 'notifications') return notificationsPage(session());
  if (state.page === 'dashboard') {
    const today=todayISO();
    const unavailable=d.doctors.filter(x=>x.available===false).length;
    const recent=d.appointments.length ? d.appointments.slice(-5).reverse().map(a=>appointmentHTML(a,d.doctors.find(x=>x.id===a.doctorId))).join('') : '<div class="empty">No appointments have been booked yet.</div>';
    return `<div class="content"><div class="welcome-row"><div><h1>Good day, Admin.</h1><p>Manage doctors, patients, appointments and availability from one place.</p></div><button class="primary-btn" data-action="add-doctor">+ Add new doctor</button></div><div class="stats-grid"><div class="stat"><span class="stat-icon">▣</span><b>${d.appointments.filter(a=>a.date===today&&a.status==='Confirmed').length}</b><span>Appointments today</span></div><div class="stat"><span class="stat-icon">♟</span><b>${d.doctors.length}</b><span>Total doctors</span></div><div class="stat"><span class="stat-icon">♧</span><b>${d.users.filter(u=>u.role==='patient').length}</b><span>Registered patients</span></div></div><div class="notice-banner ${unavailable?'warning':'success'}"><strong>${unavailable?`⚠ ${unavailable} doctor${unavailable>1?'s are':' is'} unavailable`:'✓ All doctors currently marked available'}</strong><span>Changing a doctor's status automatically creates patient notifications for affected confirmed visits.</span></div><div class="assistant-teaser"><div><span class="ai-badge">✦ AI</span><h3>CareConnect AI for Admin</h3><p>Ask about doctors, patients, medicines or appointment workflows.</p></div><button class="secondary-btn" data-page="assistant">Open AI Assistant →</button></div><div class="section-head"><h3>Recent appointments</h3><button class="link-btn" data-page="appointments">View all →</button></div><div class="card">${recent}</div></div>`;
  }
  if (state.page === 'doctors') return doctorsPage(true);
  if (state.page === 'patients') return patientTable(d);
  return adminAppointments(d);
}

function adminAppointments(d) {
  return `<div class="content"><div class="toolbar"><input class="search-input" data-search placeholder="Search patient or doctor" value="${esc(state.search)}"></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Patient</th><th>Doctor</th><th>Mode</th><th>Date & time</th><th>Reason / Token</th><th>Status</th><th>Action</th></tr></thead><tbody>${d.appointments.filter(a=>!state.search||`${a.patientName} ${d.doctors.find(x=>x.id===a.doctorId)?.name||''}`.toLowerCase().includes(state.search.toLowerCase())).map(a=>{const doc=d.doctors.find(x=>x.id===a.doctorId);return `<tr><td>${esc(a.patientName)}</td><td>Dr. ${esc(doc?.name||'Removed')}</td><td>${a.mode==='online'?'Online video':'Offline'}</td><td>${formatDate(a.date)} · ${esc(a.time)}</td><td>${esc(a.reason)}${a.mode==='offline'?`<br><strong>Token #${esc(a.tokenNumber)}</strong>`:''}</td><td><span class="status ${String(a.status).toLowerCase()}">${esc(a.status)}</span></td><td>${a.status==='Confirmed'?`<button class="action-btn" data-complete="${a.id}">Complete</button><button class="action-btn danger" data-cancel="${a.id}">Cancel</button>`:'—'}</td></tr>`;}).join('')||'<tr><td colspan="7" class="empty">No appointments found.</td></tr>'}</tbody></table></div></div>`;
}

function patientTable(d) {
  const users=d.users.filter(u=>u.role==='patient');
  return `<div class="content"><div class="section-head"><div><h3>Registered patients</h3><p class="muted-copy">Edit any profile field when needed and view the previous saved versions.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Patient</th><th>Email</th><th>Phone</th><th>Age</th><th>Appointments</th><th>Action</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone)}</td><td>${esc(u.age||'—')}</td><td>${d.appointments.filter(a=>a.patientId===u.id).length}</td><td><button class="action-btn" data-editpatient="${u.id}">Edit & history</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">No patients have registered yet.</td></tr>'}</tbody></table></div></div>`;
}

function notificationsPage(user) {
  const d=db();
  const list=d.notifications.filter(n=>n.userId===user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return `<div class="content"><div class="section-head"><div><h3>Your notifications</h3><p class="muted-copy">Updates about doctor availability, appointments and CareConnect activity.</p></div><button class="secondary-btn" data-read-all>Mark all as read</button></div><div class="notification-list">${list.length ? list.map(n=>`<article class="notification-card ${n.type} ${n.read?'read':''}"><div class="notification-icon">${n.type==='warning'?'⚠':n.type==='success'?'✓':'🔔'}</div><div><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><small>${new Date(n.createdAt).toLocaleString('en-IN')}</small></div>${n.read?'':'<span class="unread-dot"></span>'}</article>`).join('') : '<div class="card empty">You have no notifications right now.</div>'}</div></div>`;
}

function openModal(html, wide=false) {
  const modal=document.getElementById('modal');
  const card=modal.querySelector('.modal-card');
  card.classList.toggle('modal-wide',wide);
  document.getElementById('modalContent').innerHTML=html;
  modal.classList.remove('hidden');

  // Bind Save actions directly to the freshly-created modal controls.
  // This is intentionally separate from the document-level delegation so
  // Save still works reliably even when a browser handles the dynamic form
  // activation differently.
  const doctorSave = modal.querySelector('[data-save-doctor]');
  if (doctorSave) {
    doctorSave.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      saveDoctorForm(document.getElementById('doctorForm'));
    });
  }
  const patientSave = modal.querySelector('[data-save-patient]');
  if (patientSave) {
    patientSave.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      savePatientForm(document.getElementById('patientForm'));
    });
  }
}

function closeModal() {
  stopCallMedia();
  document.getElementById('modal').classList.add('hidden');
  const card=document.querySelector('.modal-card');
  card?.classList.remove('modal-wide');
  state.activeCall=null;
}

function doctorModal(id) {
  const d=db(), user=session();
  const doc=id?d.doctors.find(x=>x.id===id):{};
  const doctorSelf=user.role==='doctor';
  const existingAccount=id ? d.users.find(u=>u.role==='doctor'&&u.doctorId===id) : null;
  if (doctorSelf && (!doc || doc.id !== user.doctorId)) return showToast('You can only edit your own profile.');
  const title=doctorSelf?'Update my availability':id?'Edit doctor & login':'Add a doctor';
  openModal(`<h2>${title}</h2><p>${doctorSelf?'Update the schedule/status patients will see.':'Saving this form updates the doctor directory and creates/updates the matching Doctor login at the same time.'}</p><form id="doctorForm"><input type="hidden" name="id" value="${esc(id||'')}"><div class="form-grid">
    <label class="field">Doctor name<input name="name" ${doctorSelf?'readonly':''} required value="${esc(doc.name||'')}"></label>
    <label class="field">Specialty<input name="specialty" ${doctorSelf?'readonly':''} required value="${esc(doc.specialty||'')}"></label>
    <label class="field">Experience<input name="experience" ${doctorSelf?'readonly':''} required value="${esc(doc.experience||'')}"></label>
    <label class="field">Consultation fee (₹)<input name="fee" type="number" min="0" required value="${esc(doc.fee||500)}"></label>
    ${!doctorSelf ? `<label class="field">Doctor login email<input name="loginEmail" type="email" required value="${esc(existingAccount?.email||'')}"></label><label class="field">Doctor login password<input name="loginPassword" type="text" ${id?'placeholder="Leave blank to keep current password"':'required'} value=""></label>` : ''}
    <label class="field full">Available days<input name="availability" required value="${esc(doc.availability||'Mon, Wed, Fri')}" placeholder="e.g. Mon, Wed, Fri"></label>
    <label class="field full">Time slots<input name="slots" required value="${esc((doc.slots||['09:00','11:00','16:00']).join(', '))}" placeholder="09:00, 11:00, 16:00"></label>
    <label class="field full availability-toggle"><span>Booking status</span><label class="toggle"><input type="checkbox" name="available" ${doc.available!==false?'checked':''}><span></span></label><small>When unavailable, patients cannot book this doctor and affected confirmed appointments generate notifications.</small></label>
  </div><div class="modal-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button type="submit" class="primary-btn" data-save-doctor>Save ${doctorSelf?'changes':'doctor'}</button></div></form>`);
}

function bookingModal(doctorId, appointmentId) {
  const d=db(), doc=getDoctor(d,doctorId), a=appointmentId?d.appointments.find(x=>x.id===appointmentId):null;
  if(!doc) return showToast('Doctor is no longer available.');
  if(doc.available===false && !appointmentId) return showToast('This doctor is currently unavailable. Please choose another doctor.');
  const defaultMode=a?.mode || 'offline';
  const tokenPreview=defaultMode==='offline' ? nextOfflineToken(d,doctorId,a?.date || todayISO(), appointmentId||'') : null;
  openModal(`<h2>${appointmentId?'Reschedule':'Book'} with Dr. ${esc(doc.name)}</h2><p>${esc(doc.specialty)} · ₹${esc(doc.fee)} consultation · Schedule: ${esc(doc.availability)}</p>
    <form id="bookingForm"><input type="hidden" name="doctorId" value="${esc(doc.id)}"><input type="hidden" name="appointmentId" value="${esc(appointmentId||'')}" />
    <div class="mode-picker"><label class="mode-option"><input type="radio" name="mode" value="online" ${defaultMode==='online'?'checked':''}><span>💻 <strong>Online video</strong><small>Browser video + chat</small></span></label><label class="mode-option"><input type="radio" name="mode" value="offline" ${defaultMode==='offline'?'checked':''}><span>🏥 <strong>Offline visit</strong><small>Token number assigned</small></span></label></div>
    <div class="form-grid"><label class="field">Appointment date<input name="date" type="date" min="${todayISO()}" required value="${esc(a?.date||'')}"></label><label class="field">Time slot<select name="time" required>${doc.slots.map(s=>`<option ${a?.time===s?'selected':''}>${esc(s)}</option>`).join('')}</select></label><label class="field full">Reason for visit<input name="reason" required value="${esc(a?.reason||'')}" placeholder="e.g. Fever, skin check-up, routine consultation"></label></div>
    <div id="tokenPreview" class="token-preview ${defaultMode==='online'?'hidden':''}">🎟 <strong>Offline token:</strong> #${tokenPreview}</div>
    <div class="booking-note">${doc.available===false ? 'This doctor is currently unavailable. Existing bookings may be affected and the patient will be notified.' : 'Choose online for a video consultation or offline for a token-based clinic visit.'}</div>
    <div class="modal-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn">${appointmentId?'Save changes':'Confirm appointment'}</button></div></form>`);
}

function patientEditModal(id) {
  const d=db(), u=d.users.find(x=>x.id===id);
  if(!u)return;
  ensurePatientDefaults(u);
  const history=(u.profileHistory||[]).slice().reverse();
  const historyHtml=history.length ? history.map((h,i)=>`<details class="history-item" ${i===0?'open':''}><summary>Previous version · ${new Date(h.changedAt).toLocaleString('en-IN')}</summary><div class="history-grid"><span>Name<strong>${esc(h.name)}</strong></span><span>Email<strong>${esc(h.email)}</strong></span><span>Phone<strong>${esc(h.phone)}</strong></span><span>Age<strong>${esc(h.age||'—')}</strong></span><span>Gender<strong>${esc(h.gender||'—')}</strong></span><span>Blood group<strong>${esc(h.bloodGroup||'—')}</strong></span><span>Address<strong>${esc(h.address||'—')}</strong></span><span>Emergency contact<strong>${esc(h.emergencyContact||'—')}</strong></span></div></details>`).join('') : '<div class="empty compact">No previous edits are stored yet.</div>';
  openModal(`<h2>Edit patient & view previous data</h2><p>Every saved change stores a snapshot of the previous patient profile for review.</p><form id="patientForm"><input type="hidden" name="id" value="${esc(u.id)}"><div class="form-grid"><label class="field full">Full name<input name="name" required value="${esc(u.name)}"></label><label class="field">Email<input name="email" type="email" required value="${esc(u.email)}"></label><label class="field">Phone<input name="phone" required value="${esc(u.phone)}"></label><label class="field">Age<input name="age" type="number" min="0" max="120" value="${esc(u.age)}"></label><label class="field">Gender<select name="gender"><option value="">Select</option><option ${u.gender==='Male'?'selected':''}>Male</option><option ${u.gender==='Female'?'selected':''}>Female</option><option ${u.gender==='Other'?'selected':''}>Other</option></select></label><label class="field">Blood group<input name="bloodGroup" value="${esc(u.bloodGroup)}" placeholder="e.g. B+"></label><label class="field">Emergency contact<input name="emergencyContact" value="${esc(u.emergencyContact)}"></label><label class="field full">Address<input name="address" value="${esc(u.address)}"></label></div><div class="modal-actions"><button type="button" class="secondary-btn" data-close>Close</button><button type="submit" class="primary-btn" data-save-patient>Save patient changes</button></div></form><div class="history-section"><h3>Previous patient data</h3>${historyHtml}</div>`);
}

const MEDICINES = {
  paracetamol:{aliases:['acetaminophen','dolo 650','dolo','crocin','calpol'],use:'commonly used to reduce fever and relieve mild-to-moderate pain.',notes:'Follow the label or clinician instructions. Too much can seriously harm the liver.',specialty:'General Physician'},
  ibuprofen:{aliases:['brufen','ibuprofen tablet','ibuprofen'],use:'an anti-inflammatory medicine commonly used for pain, fever and inflammation.',notes:'It can irritate the stomach and is not suitable for everyone. Ask a professional if you have health conditions or take other medicines.',specialty:'General Physician'},
  cetirizine:{aliases:['cetirizine tablet','zyrtec'],use:'an antihistamine commonly used for allergy symptoms such as sneezing, itching and a runny nose.',notes:'Some people feel drowsy. Follow label or professional advice.',specialty:'General Physician'},
  levocetirizine:{aliases:['levocetirizine tablet','levocet'],use:'an antihistamine commonly used for allergy symptoms such as sneezing, itching and a runny nose.',notes:'It can cause drowsiness in some people. Follow professional or label directions.',specialty:'General Physician'},
  amoxicillin:{aliases:['amoxycillin','amoxicillin tablet'],use:'an antibiotic used for certain bacterial infections.',notes:'It does not treat viral illnesses such as a common cold. Use antibiotics only when prescribed and complete the course as directed.',specialty:'General Physician'},
  azithromycin:{aliases:['azithro','azithromycin tablet'],use:'an antibiotic used for some bacterial infections.',notes:'It is prescription medicine and is not appropriate for every infection. Take it only as directed by a clinician.',specialty:'General Physician'},
  omeprazole:{aliases:['omez','omeprazole tablet'],use:'a proton-pump inhibitor that reduces stomach acid and is commonly used for acid reflux and some ulcer-related conditions.',notes:'Persistent or severe stomach symptoms should be assessed by a clinician.',specialty:'General Physician'},
  pantoprazole:{aliases:['pantoprazole tablet','pantop','pantocid'],use:'a proton-pump inhibitor that reduces stomach acid and is commonly used for acid reflux and related conditions.',notes:'Use according to professional advice, especially when symptoms keep returning.',specialty:'General Physician'},
  metformin:{aliases:['metformin tablet','glycomet'],use:'a medicine commonly used to help control blood sugar in type 2 diabetes.',notes:'It requires clinician guidance and blood-sugar monitoring. Do not change the dose yourself.',specialty:'General Physician'},
  amlodipine:{aliases:['amlodipine tablet','amlodipine besylate'],use:'a medicine commonly used to help control high blood pressure and certain heart-related conditions.',notes:'Take blood-pressure medicines according to the prescribed plan. Do not stop them without medical advice.',specialty:'Cardiologist'},
  atorvastatin:{aliases:['atorvastatin tablet','atorva'],use:'a statin medicine used to lower cholesterol and reduce cardiovascular risk.',notes:'It is prescription medicine and usually needs clinical follow-up.',specialty:'Cardiologist'},
  ondansetron:{aliases:['ondansetron tablet','ondem'],use:'a medicine commonly used to help prevent nausea and vomiting.',notes:'The cause of repeated vomiting should be assessed by a healthcare professional.',specialty:'General Physician'},
  domperidone:{aliases:['domperidone tablet','domstal'],use:'a medicine that may be prescribed for certain nausea or stomach-motility problems.',notes:'It is not suitable for everyone and can have heart-related risks, so use it only with professional advice.',specialty:'General Physician'},
  diclofenac:{aliases:['diclofenac tablet','voveran'],use:'an anti-inflammatory pain medicine used for some types of pain and inflammation.',notes:'It can affect the stomach, kidneys and cardiovascular system, so professional guidance is important.',specialty:'Orthopedic'},
  montelukast:{aliases:['montelukast tablet','montair'],use:'a medicine used in some people with asthma or allergies to help control symptoms.',notes:'It is not a rescue medicine for a sudden asthma attack. Follow the prescribed plan.',specialty:'General Physician'},
  albendazole:{aliases:['albendazole tablet','zentel'],use:'an antiparasitic medicine used for certain worm infections.',notes:'The correct treatment depends on the type of infection, age and other factors; professional advice is recommended.',specialty:'General Physician'},
  calcium:{aliases:['calcium tablet','calcium carbonate'],use:'a mineral supplement used when dietary calcium intake is inadequate or supplementation is advised.',notes:'More is not always better. Some supplements interact with other medicines.',specialty:'General Physician'},
  iron:{aliases:['iron tablet','ferrous sulfate','ferrous fumarate'],use:'an iron supplement commonly used to prevent or treat iron deficiency when advised.',notes:'Iron should be used when deficiency is suspected or confirmed, because excess iron can be harmful.',specialty:'General Physician'},
  aspirin:{aliases:['aspirin tablet','asa'],use:'a medicine with pain-relieving and antiplatelet effects; low doses are used for some cardiovascular conditions under medical advice.',notes:'It can increase bleeding risk and is not appropriate for everyone. Do not start it for heart protection without a clinician.',specialty:'Cardiologist'},
  losartan:{aliases:['losartan tablet'],use:'a medicine commonly used to treat high blood pressure and some heart or kidney-related conditions.',notes:'Blood-pressure medicines need professional guidance, especially during pregnancy or with kidney problems.',specialty:'Cardiologist'},
  metoprolol:{aliases:['metoprolol tablet','metolar'],use:'a beta-blocker commonly used for certain heart conditions and high blood pressure.',notes:'Do not stop a beta-blocker suddenly without medical advice.',specialty:'Cardiologist'},
  furosemide:{aliases:['furosemide tablet','frusemide','lasix'],use:'a diuretic (water tablet) used for fluid retention and certain heart, liver or kidney conditions.',notes:'It can change fluid and electrolyte levels, so it should be used as prescribed.',specialty:'Cardiologist'},
  fluconazole:{aliases:['fluconazole tablet','fluka'],use:'an antifungal medicine used for certain fungal infections.',notes:'It can interact with other medicines and is not suitable for every infection. Use professional advice.',specialty:'General Physician'},
  doxycycline:{aliases:['doxycycline tablet'],use:'an antibiotic used for certain bacterial infections and some skin conditions.',notes:'Take only when prescribed. It can interact with some minerals and medicines and can increase sun sensitivity.',specialty:'Dermatologist'},
  clotrimazole:{aliases:['clotrimazole tablet','clotrimazole'],use:'an antifungal medicine used for certain fungal infections; dosage form matters because creams and tablets are used differently.',notes:'Use the exact form prescribed or recommended because different products are used for different conditions.',specialty:'Dermatologist'},
  prednisolone:{aliases:['prednisolone tablet','wysolone'],use:'a corticosteroid used to reduce inflammation in certain medical conditions.',notes:'It should be taken only under professional guidance because stopping or changing it suddenly can be unsafe in some situations.',specialty:'General Physician'},
  levothyroxine:{aliases:['levothyroxine tablet','thyronorm'],use:'a thyroid hormone replacement medicine used to treat hypothyroidism.',notes:'The dose is individualized and usually monitored with blood tests. Take it exactly as prescribed.',specialty:'General Physician'},
  vitamin_d:{aliases:['vitamin d tablet','vit d3','cholecalciferol','calcirol'],use:'a vitamin D supplement used when vitamin D intake or levels are low, when supplementation is advised.',notes:'Very high doses can be harmful. Follow the recommended product or professional guidance.',specialty:'General Physician'},
  vitamin_b12:{aliases:['vitamin b12 tablet','methylcobalamin','mecobalamin'],use:'a vitamin supplement used to prevent or treat vitamin B12 deficiency.',notes:'The right treatment depends on the cause of deficiency; persistent symptoms should be assessed by a clinician.',specialty:'General Physician'},
  azelastine:{aliases:['azelastine tablet'],use:'an antihistamine mainly used in certain allergy conditions, although dosage form and indication depend on the product.',notes:'Check the exact formulation because the same ingredient may come in different forms.',specialty:'General Physician'},
  buspirone:{aliases:['buspirone tablet'],use:'a prescription medicine used for certain anxiety disorders.',notes:'It requires clinician supervision and is not a quick-relief medicine for every type of anxiety.',specialty:'General Physician'},
  gabapentin:{aliases:['gabapentin tablet','gabapin'],use:'a prescription medicine commonly used for certain nerve pain and some seizure disorders.',notes:'It can cause dizziness or sleepiness and should be used under medical supervision.',specialty:'General Physician'},
  pregabalin:{aliases:['pregabalin tablet','pregaba'],use:'a prescription medicine used for certain nerve pain and some seizure-related conditions.',notes:'It may cause dizziness or sleepiness and should be taken only as prescribed.',specialty:'General Physician'},
  naproxen:{aliases:['naproxen tablet'],use:'an anti-inflammatory medicine used for pain and inflammation.',notes:'It can affect the stomach, kidneys and cardiovascular system, so professional advice is important.',specialty:'Orthopedic'},
  mefenamic_acid:{aliases:['mefenamic acid tablet','meftal'],use:'an anti-inflammatory pain medicine used for certain types of pain.',notes:'It can affect the stomach and should be used according to professional advice.',specialty:'General Physician'},
  ondansetron_odt:{aliases:['ondansetron odt','ondansetron mouth dissolving'],use:'a dissolving form of ondansetron used to help prevent nausea and vomiting.',notes:'Follow the product instructions and seek care if vomiting is persistent or severe.',specialty:'General Physician'}
};

function normalizeMedicineQuery(text) {
  const cleaned=text.toLowerCase().replace(/[^a-z0-9\s.-]/g,' ');
  for (const [name,info] of Object.entries(MEDICINES)) {
    const names=[name,...(info.aliases||[])];
    if(names.some(alias=>cleaned.includes(alias.toLowerCase()))) return {name,info};
  }
  return null;
}

function sortDoctorsByRating(list) {
  return [...list].sort((a, b) => {
    const avgA = ratingAvg(a); const avgB = ratingAvg(b);
    if (avgA == null && avgB == null) return a.name.localeCompare(b.name);
    if (avgA == null) return 1;
    if (avgB == null) return -1;
    if (avgB !== avgA) return avgB - avgA;
    return (b.ratingCount||0) - (a.ratingCount||0);
  });
}

// Always reads live from storage, so a doctor added moments ago (by Admin
// or via doctor signup) shows up immediately, sorted best-rated first.
function availableDoctorsText(specialty, allowBooking=true, selfDoctorId=null) {
  const all=db().doctors;
  const doctors=sortDoctorsByRating(all.filter(d => !specialty || d.specialty.toLowerCase().includes(specialty.toLowerCase())));
  if (!doctors.length) {
    const fallback=sortDoctorsByRating(all.filter(d=>d.available!==false)).slice(0,3);
    if (!fallback.length) return '<div class="ai-empty">No doctors are currently available in the CareConnect directory.</div>';
    return `<div class="ai-fallback">No exact ${esc(specialty)} match was found. Here are currently listed doctors:</div>${fallback.map(d=>aiDoctorCard(d,allowBooking,selfDoctorId)).join('')}`;
  }
  return doctors.map(d=>aiDoctorCard(d,allowBooking,selfDoctorId)).join('');
}

function aiDoctorCard(d, allowBooking=true, selfDoctorId=null) {
  const isSelf = selfDoctorId && d.id===selfDoctorId;
  let action = '<span class="ai-offline">Unavailable</span>';
  if (isSelf) action = '<span class="ai-offline">This is you</span>';
  else if (allowBooking && d.available!==false) action = `<button class="action-btn" data-ai-book="${esc(d.id)}">Book</button>`;
  else if (d.available!==false) action = '';
  return `<div class="ai-doctor ${d.available===false?'unavailable':''}"><span>🩺</span><div><strong>Dr. ${esc(d.name)}${isSelf?' (You)':''}</strong><small>${esc(d.specialty)} · ${esc(d.availability)} · ₹${esc(d.fee)} · ${d.available===false?'Unavailable':'Available'}</small>${ratingBadgeHTML(d)}</div>${action}</div>`;
}

function medicineReply(text) {
  const match=normalizeMedicineQuery(text);
  if(!match){
    const requested=text.match(/(?:what is|about|uses of|use of|tell me about|information on|what does|why is)\s+([a-z][a-z0-9 .-]{1,50})/i)?.[1]?.trim();
    return `<strong>CareConnect AI Assistant</strong><br>I can explain a medicine’s <strong>common purpose, general precautions, and relevant CareConnect doctors</strong>. I won't guess an unknown tablet because different medicines can have similar names.<br><br>${requested?`I couldn't verify <strong>${esc(requested)}</strong> in this offline medicine guide. `:''}Type the exact medicine name printed on the strip, for example <strong>Paracetamol</strong>, <strong>Metformin</strong>, <strong>Omeprazole</strong>, or <strong>Amoxicillin</strong>. For personal treatment or dosage, consult a qualified doctor or pharmacist.`;
  }
  const {name,info}=match;
  const role=session()?.role;
  return `<div class="medicine-answer"><div class="medicine-title"><span>💊</span><div><strong>${esc(name.split('_').map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(' '))}</strong><small>General medicine information</small></div></div><p><strong>What it is used for:</strong> ${esc(info.use)}</p><p><strong>Important to know:</strong> ${esc(info.notes)}</p><div class="ai-note">🤖 I’m the <strong>CareConnect AI Assistant</strong>. I can explain medicines in general, but I do not diagnose, prescribe, or provide personalized doses.</div><div class="ai-doctors-title">👨‍⚕️ Relevant doctors in CareConnect</div>${availableDoctorsText(info.specialty, role==='patient', role==='doctor'?selfDoctorId():null)}</div>`;
}

// The doctor's own doctor-record id, when the signed-in user is a doctor.
function selfDoctorId() {
  const u=session();
  return u && u.role==='doctor' ? u.doctorId : null;
}

// Each role gets a distinct voice and distinct actions from the assistant:
// patients get booking-oriented help, doctors get their own-practice info,
// admin gets directory/records-management guidance.
function aiReply(message) {
  const user=session();
  const role=user?.role || 'patient';
  const text=message.toLowerCase().trim();
  if(!text)return 'Please type a question and I’ll try to help.';

  if(/\b(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    if(role==='doctor') return `Hi Dr. ${esc(user.name.split(' ')[0])} 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about your appointments, your availability, patient tokens, or a medicine you want a quick refresher on.`;
    if(role==='admin') return 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about managing doctors or patients, viewing appointments and tokens, or how ratings and notifications work.';
    return 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. I can explain common medicines/tablets, guide you about symptoms in general, find doctors, explain online vs offline visits, and help with appointments. I’m not a replacement for a qualified doctor.';
  }

  if(/\b(tablet|medicine|capsule|syrup|drug|medication)\b/.test(text) || normalizeMedicineQuery(text)) return medicineReply(text);

  if(/\b(token|offline visit|clinic visit|in person)\b/.test(text)) {
    if(role==='doctor') return `<strong>Offline tokens:</strong> when a patient books an <strong>Offline visit</strong> with you, CareConnect assigns them the next token number for that date automatically. You'll see each patient's token on their appointment card.`;
    if(role==='admin') return `<strong>Offline tokens:</strong> CareConnect assigns the next token number per <strong>doctor + date</strong> when a patient books an offline visit. Open <strong>All Appointments</strong> to see every token across doctors and dates.`;
    return `<strong>Offline appointment:</strong> choose <strong>Offline visit</strong> while booking. CareConnect assigns a token number for that doctor and date, which appears in My Appointments and on the admin/doctor side.`;
  }

  if(/\b(online|video call|video consultation|teleconsult|virtual)\b/.test(text)) {
    if(role==='doctor') return `<strong>Online consultations:</strong> when a patient books an <strong>Online video</strong> visit with you, open it from your Appointments list at the scheduled time to start the camera, microphone and appointment chat.`;
    if(role==='admin') return `<strong>Online consultations:</strong> appointments booked as Online show that mode in <strong>All Appointments</strong>. Admin doesn't join the call — that happens directly between the patient and doctor from their own appointment cards.`;
    return `<strong>Online appointment:</strong> choose <strong>Online video</strong> while booking. At appointment time, you and the doctor can open the video room with <strong>camera, microphone and chat controls</strong>. Ending the call will ask you to rate your doctor.`;
  }

  if(/\b(unavailable|not available|doctor absent|doctor not available)\b/.test(text)) {
    if(role==='doctor') return `<strong>Marking yourself unavailable:</strong> use the availability toggle on your own profile. Patients with confirmed upcoming visits are notified automatically so they know to expect a reschedule.`;
    if(role==='admin') return `<strong>Doctor availability:</strong> toggle any doctor's status from <strong>Manage Doctors</strong>. Marking a doctor unavailable blocks new bookings and automatically notifies patients with affected confirmed visits.`;
    return `<strong>Doctor unavailable:</strong> when a doctor is marked unavailable, new booking is blocked and affected confirmed patients receive a CareConnect notification. Check the <strong>Notifications</strong> page for details.`;
  }

  if(/(rating|review|stars|rate my|rate a doctor|rate the doctor)/.test(text)) {
    if(role==='doctor') {
      const doc=getDoctor(db(), user.doctorId);
      const avg=doc?ratingAvg(doc):null;
      const summary=doc && avg!=null ? `Your current rating is <strong>${avg.toFixed(1)}★</strong> from ${doc.ratingCount} patient${doc.ratingCount===1?'':'s'}.` : `You don't have any patient ratings yet.`;
      return `<strong>Doctor ratings:</strong> patients can rate you (1–5 stars) after a completed appointment, or automatically when they end an online video call with you. ${summary} Ratings decide how patients see doctors suggested in <strong>Find a doctor</strong>, and can't be edited by you or Admin.`;
    }
    if(role==='admin') return `<strong>Doctor ratings:</strong> patients rate a doctor (1–5 stars, optional comment) after a completed appointment. The <strong>Find a doctor</strong> list patients see is always sorted by average rating, and the top-rated doctor gets a 🏆 badge. Open <strong>Manage Doctors</strong> to see each doctor's current rating — ratings are patient feedback and aren't editable by Admin.`;
    return `<strong>Rating your doctor:</strong> from a completed appointment, use the <strong>⭐ Rate this doctor</strong> button — or if it was an online visit, ending the video call opens the rating dialog automatically. You can edit your rating later from <strong>My Appointments</strong>, and it always counts once toward the doctor's average.`;
  }

  if(/(add doctor|new doctor|remove doctor|delete doctor|manage doctor)/.test(text)) {
    if(role==='admin') return `<strong>Managing doctors:</strong> open <strong>Manage Doctors → + Add doctor</strong> to create a doctor profile and login together. Use <strong>Edit doctor</strong> to update details, fee or schedule, and <strong>Remove</strong> to delete a doctor (blocked while they still have active confirmed appointments).`;
    if(role==='doctor') return `Only Admin can add or remove doctors from the CareConnect directory. If you need your own profile or fee updated, ask Admin, or update your own availability and time slots from your profile.`;
    return `Doctors are added by CareConnect Admin, or a doctor can create their own account from <strong>Create an account → Doctor</strong> on the sign-in screen.`;
  }

  if(/(edit patient|patient record|patient data|patient profile)/.test(text)) {
    if(role==='admin') return `<strong>Editing patient records:</strong> open <strong>Patients → Edit & history</strong> to update a patient's name, contact, age, gender, blood group, address or emergency contact. Every save keeps a previous-version snapshot you can review.`;
    if(role==='doctor') return `You can see a patient's contact details on their appointment card. Detailed profile edits (address, blood group, emergency contact) are managed by CareConnect Admin.`;
    return `Your own detailed profile fields (address, blood group, emergency contact, etc.) are currently managed by CareConnect Admin on request. You're always able to see your own info from your account.`;
  }

  if(/(skin|rash|acne|itch|eczema|allergy)/.test(text)) return roleDoctorListReply(role, 'Dermatologist', `<strong>For skin-related concerns:</strong> a dermatologist can assess many skin problems.`);
  if(/(chest pain|heart|palpitation|blood pressure|\bbp\b)/.test(text)) return roleDoctorListReply(role, 'Cardiologist', `<strong>For heart or blood-pressure concerns:</strong> a cardiologist or general physician can assess the issue. Sudden severe chest pain or severe breathing difficulty needs urgent medical care.`);
  if(/(bone|joint|back pain|knee|fracture|shoulder|muscle)/.test(text)) return roleDoctorListReply(role, 'Orthopedic', `<strong>For bone, joint or muscle problems:</strong> an orthopedic doctor can evaluate many musculoskeletal concerns.`);
  if(/(child|baby|kid|pediatric)/.test(text)) return roleDoctorListReply(role, 'Pediatrician', `<strong>For children's health:</strong> a pediatrician specializes in healthcare for children.`);
  if(/(fever|cold|cough|headache|stomach pain|vomiting|weakness|general health)/.test(text)) return roleDoctorListReply(role, 'General Physician', `<strong>General health concern:</strong> a General Physician can assess common symptoms and decide whether a specialist is needed.`);

  if(/(available doctors|which doctors|doctor available|find a doctor|specialist|who can i see|show doctors)/.test(text)) {
    const list=availableDoctorsText('', role==='patient', role==='doctor'?selfDoctorId():null);
    if(role==='doctor') return `<strong>Here's the current CareConnect doctor directory</strong> (this updates immediately whenever Admin or a new doctor adds a profile):${list}`;
    if(role==='admin') return `<strong>Full doctor directory</strong>, sorted by rating — the same list new doctors join the moment they're added. Edit any of them from <strong>Manage Doctors</strong>:${list}`;
    return `<strong>Here are the doctors currently listed in CareConnect</strong>, best-rated first — this always includes doctors added just now:${list}`;
  }

  if(/(book|appointment|schedule|reschedule|cancel)/.test(text)) {
    if(role==='doctor') return `As a doctor, appointments are booked by patients — you don't book them yourself. From <strong>My Appointments</strong> you can view visits, mark them <strong>Complete</strong> or <strong>Cancelled</strong>, and join online video visits. To change what patients can book, update your availability, days and time slots from your profile.`;
    if(role==='admin') return `Admin doesn't book appointments directly. Open <strong>All Appointments</strong> to view every booking with its online/offline mode and token, or use <strong>Manage Doctors</strong> / <strong>Patients</strong> to edit records.`;
    return 'To book an appointment, open <strong>Find a Doctor</strong>, select a doctor, choose <strong>Online video</strong> or <strong>Offline visit</strong>, pick a date and slot, then confirm. Reschedule and cancel are available from <strong>My Appointments</strong>.';
  }

  if(/(mic|microphone|camera|cam|chat)/.test(text)) {
    if(role==='doctor') return `<strong>Online call controls:</strong> when you join a patient's video visit, you'll have separate buttons for <strong>microphone</strong> and <strong>camera</strong> on/off, plus the appointment <strong>chat box</strong> alongside the call.`;
    return '<strong>Online call controls:</strong> the video room includes separate buttons to turn your <strong>microphone</strong> and <strong>camera</strong> on/off, plus a live appointment <strong>chat box</strong>.';
  }

  if(/(emergency|urgent|breathing|unconscious|severe bleeding)/.test(text)) return 'This assistant is not an emergency service. For severe, sudden, or life-threatening symptoms, seek immediate medical care or contact your local emergency service.';

  if(role==='doctor') return `I’m the <strong>CareConnect AI Assistant</strong>. Try asking <strong>“Which doctors are available?”</strong> to see the live directory, <strong>“How do ratings work?”</strong>, <strong>“How does an offline token work?”</strong>, or <strong>“What is metformin?”</strong> for a quick medicine refresher.`;
  if(role==='admin') return `I’m the <strong>CareConnect AI Assistant</strong>. Try asking <strong>“How do I add a doctor?”</strong>, <strong>“How do ratings work?”</strong>, <strong>“Which doctors are available?”</strong>, or <strong>“How do I edit a patient record?”</strong>.`;
  return `I’m the <strong>CareConnect AI Assistant</strong>. Try asking <strong>“What is paracetamol tablet used for?”</strong>, <strong>“What is metformin?”</strong>, <strong>“Which doctors are available?”</strong>, <strong>“How does an offline token work?”</strong>, or <strong>“How does the online video call work?”</strong>.`;
}

function roleDoctorListReply(role, specialty, intro) {
  const list=availableDoctorsText(specialty, role==='patient', role==='doctor'?selfDoctorId():null);
  if(role==='doctor') return `${intro} Here are the currently listed ${esc(specialty)} doctors in CareConnect:${list}`;
  if(role==='admin') return `${intro} Here are the currently listed ${esc(specialty)} doctors — edit any from Manage Doctors:${list}`;
  return `${intro} CareConnect can show the doctors currently listed:${list}`;
}

function assistantChips(role) {
  if(role==='doctor') return [
    ['👨‍⚕️ Doctor directory','Which doctors are available?'],
    ['⭐ My rating','How do ratings work?'],
    ['🎟 Offline tokens','How does an offline token work?'],
    ['💻 Online visit','How does the online video call work?'],
    ['💊 Metformin','What is metformin tablet used for?'],
  ];
  if(role==='admin') return [
    ['👨‍⚕️ Doctor directory','Which doctors are available?'],
    ['➕ Add a doctor','How do I add a doctor?'],
    ['✎ Edit a patient','How do I edit a patient record?'],
    ['⭐ Ratings','How do ratings work?'],
    ['🎟 Offline tokens','How does an offline token work?'],
  ];
  return [
    ['💊 Paracetamol','What is paracetamol tablet used for?'],
    ['💊 Metformin','What is metformin tablet used for?'],
    ['👨‍⚕️ Available doctors','Which doctors are available?'],
    ['🎟 Offline token','How does an offline token work?'],
    ['💻 Online visit','How does the online video call work?'],
  ];
}

function assistantPage() {
  const user=session();
  const roleTag = user.role==='doctor' ? 'CareConnect AI · Doctor view' : user.role==='admin' ? 'CareConnect AI · Admin view' : 'CareConnect AI · Patient view';
  const intro = user.role==='doctor'
    ? 'Ask about your appointments, availability, patient tokens, your rating, or a quick medicine refresher.'
    : user.role==='admin'
    ? 'Ask about managing doctors and patients, appointments, tokens, or ratings.'
    : 'Ask naturally about medicines, tablets, symptoms, doctors, online/offline visits or appointments.';
  const chips=assistantChips(user.role).map(([label,prompt])=>`<button type="button" class="ai-chip" data-ai-prompt="${esc(prompt)}">${label}</button>`).join('');
  const starter=`<div class="ai-chat"><div class="ai-chat-head"><div><span class="ai-badge">✦ AI ASSISTANT</span><h2>CareConnect Assistant</h2><p>${intro}</p></div><span class="ai-mode">${roleTag}</span></div><div class="ai-quick">${chips}</div><div id="chatMessages" class="chat-messages"></div><form id="chatForm" class="chat-input"><input id="chatInput" autocomplete="off" placeholder="Ask about a medicine, doctor or appointment…"><button class="primary-btn" type="submit">➤</button></form><p class="ai-disclaimer">I’m an AI assistant for general information and CareConnect navigation. I do not diagnose or prescribe. For personal treatment decisions, consult a qualified doctor or pharmacist.${user.role==='patient'?' You can book a listed doctor directly from the suggestions.':''}</p></div>`;
  return `<div class="content">${starter}</div>`;
}

function renderChat() {
  const box=document.getElementById('chatMessages');
  if(!box)return;
  if(!state.chat.length) {
    const user=session(); const role=user?.role;
    const greet = role==='doctor'
      ? `Hi Dr. ${esc(user.name.split(' ')[0])} 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about your appointments, availability, patient tokens, your rating, or a medicine.`
      : role==='admin'
      ? 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about managing doctors or patients, appointments, tokens, or ratings.'
      : 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about a common medicine/tablet, a symptom, a doctor, an online video consultation, an offline token, or an appointment.';
    state.chat.push({who:'ai',html:greet});
  }
  box.innerHTML=state.chat.map(m=>`<div class="chat-message ${m.who==='user'?'user':'ai'}"><div>${m.html}</div></div>`).join('');
  box.scrollTop=box.scrollHeight;
}

function videoCallModal(appointmentId) {
  const d=db(), a=d.appointments.find(x=>x.id===appointmentId), user=session();
  if(!a || a.mode!=='online') return showToast('This is not an online appointment.');
  const doctor=getDoctor(d,a.doctorId);
  if(!doctor) return showToast('Doctor not found.');
  const participant = user.role==='doctor' ? `Patient: ${a.patientName}` : `Dr. ${doctor.name}`;
  state.activeCall=appointmentId;
  openModal(`<div class="call-room-enhanced"><div class="call-top"><div><span class="call-live">● LIVE DEMO</span><strong>CareConnect Video Consultation</strong><small>${esc(participant)} · ${formatDate(a.date)} · ${esc(a.time)}</small></div><span class="call-mode-pill">ONLINE</span></div><div class="call-grid"><section class="video-panel"><div class="video-stage"><div class="remote-feed"><div class="remote-avatar">🩺</div><strong>${esc(user.role==='doctor'?a.patientName:`Dr. ${doctor.name}`)}</strong><small>Remote participant</small></div><div class="local-feed"><video id="localVideo" autoplay playsinline muted></video><div id="cameraFallback" class="camera-fallback">Camera preview will appear here.</div><span>You</span></div></div><div class="call-controls"><button class="call-control" id="toggleMic">🎤 Mic ON</button><button class="call-control" id="toggleCam">📷 Camera ON</button><button class="end-call" id="endCall">End call</button></div></section><aside class="call-chat-panel"><div class="call-chat-head"><strong>Appointment chat</strong><span>${esc(doctor.specialty)}</span></div><div id="callChatMessages" class="call-chat-messages"></div><form id="callChatForm" class="call-chat-input"><input id="callChatInput" placeholder="Type a message…" autocomplete="off"><button>Send</button></form></aside></div></div>`, true);
  setTimeout(startVideoCall, 80);
}

async function startVideoCall() {
  renderCallChat();
  const video=document.getElementById('localVideo'), fallback=document.getElementById('cameraFallback');
  if(!video)return;
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
    state.callStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    video.srcObject=state.callStream;
    if(fallback) fallback.classList.add('hidden');
  } catch (error) {
    if(fallback) fallback.textContent='Camera/microphone permission was not granted. The call screen and chat still work in demo mode.';
    showToast('Camera or microphone permission was not granted.');
  }
  updateCallButtons();
}

function stopCallMedia() {
  if(state.callStream){
    state.callStream.getTracks().forEach(track=>track.stop());
    state.callStream=null;
  }
}

function updateCallButtons() {
  const mic=document.getElementById('toggleMic'), cam=document.getElementById('toggleCam');
  if(mic) mic.textContent=`🎤 Mic ${state.callAudioOn?'ON':'OFF'}`;
  if(cam) cam.textContent=`📷 Camera ${state.callVideoOn?'ON':'OFF'}`;
}

function renderCallChat() {
  const box=document.getElementById('callChatMessages'), d=db(), a=d.appointments.find(x=>x.id===state.activeCall);
  if(!box || !a)return;
  a.chat=Array.isArray(a.chat)?a.chat:[];
  box.innerHTML=a.chat.length ? a.chat.map(m=>`<div class="call-chat-message ${m.senderRole==='doctor'?'doctor':'patient'}"><strong>${esc(m.senderName)}</strong><span>${esc(m.text)}</span><small>${new Date(m.createdAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</small></div>`).join('') : '<div class="chat-empty">No messages yet. Start the appointment chat.</div>';
  box.scrollTop=box.scrollHeight;
}

function storeCallMessage(text) {
  const d=db(),a=d.appointments.find(x=>x.id===state.activeCall),u=session();
  if(!a || !u || !text.trim())return;
  a.chat=Array.isArray(a.chat)?a.chat:[];
  a.chat.push({id:uid('m'),text:text.trim(),senderName:u.name,senderRole:u.role,createdAt:new Date().toISOString()});
  save(d); renderCallChat();
}


function getFormString(form, name) {
  const el = form?.elements?.namedItem(name);
  return el ? String(el.value ?? '').trim() : '';
}

function saveDoctorForm(form) {
  if (!form) return false;
  try {
    const d = normalizeData(db());
    const currentUser = session();
    const field = name => form.elements.namedItem(name);
    const value = name => String(field(name)?.value ?? '').trim();

    const id = value('id');
    const name = value('name');
    const specialty = value('specialty');
    const experience = value('experience');
    const feeText = value('fee');
    const availability = value('availability');
    const slots = value('slots').split(',').map(v => v.trim()).filter(Boolean);
    const availableEl = field('available');
    const available = availableEl ? !!availableEl.checked : true;
    const loginEmail = value('loginEmail').toLowerCase();
    const loginPassword = value('loginPassword');

    if (!name || !specialty || !experience || !availability || !slots.length || feeText === '') {
      showToast('Please fill all required doctor details.');
      return false;
    }
    const fee = Number(feeText);
    if (!Number.isFinite(fee) || fee < 0) {
      showToast('Enter a valid consultation fee.');
      return false;
    }

    const stamp = new Date().toISOString();

    if (id) {
      const doctor = d.doctors.find(q => q.id === id);
      if (!doctor) {
        showToast('Doctor record not found.');
        return false;
      }

      // Keep the patient-facing doctor directory as the source of truth.
      Object.assign(doctor, {
        name, specialty, experience, fee, availability, slots,
        available, updatedAt: stamp
      });

      let doctorUser = d.users.find(v => v.role === 'doctor' && v.doctorId === id);
      if (!doctorUser) {
        if (!loginEmail || !loginPassword) {
          showToast('Doctor login email and password are required.');
          return false;
        }
        if (d.users.some(v => String(v.email).toLowerCase() === loginEmail)) {
          showToast('That doctor login email is already in use.');
          return false;
        }
        doctorUser = {
          id: uid('doctor-user'), name, email: loginEmail, password: loginPassword,
          phone: '0000000000', role: 'doctor', doctorId: id
        };
        d.users.push(doctorUser);
      } else {
        doctorUser.name = name;
        if (currentUser?.role !== 'doctor') {
          if (loginEmail && d.users.some(v => v.id !== doctorUser.id && String(v.email).toLowerCase() === loginEmail)) {
            showToast('That doctor login email is already in use.');
            return false;
          }
          if (loginEmail) doctorUser.email = loginEmail;
          if (loginPassword) doctorUser.password = loginPassword;
        }
      }

      // Keep a currently logged-in doctor session synchronized with saved data.
      if (currentUser?.role === 'doctor' && currentUser.doctorId === id) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({...doctorUser, name, doctorId:id, role:'doctor'}));
      }

      // Notify patients with affected future confirmed appointments.
      if (!available) {
        d.appointments
          .filter(a => a.doctorId === id && a.status === 'Confirmed' && a.date >= todayISO())
          .forEach(a => {
            const patient = d.users.find(q => q.id === a.patientId);
            if (patient) createNotification(
              d, patient.id,
              `Dr. ${doctor.name} is unavailable`,
              `Your appointment on ${formatDate(a.date)} at ${a.time} is affected because the doctor is currently unavailable.`,
              'warning', `doctor-unavailable:${a.id}:${stamp}`
            );
          });
      }

      return commitData(d, 'Doctor details saved successfully. Patients and Doctor login are updated.');
    }

    if (!loginEmail || !loginPassword) {
      showToast('Doctor login email and password are required.');
      return false;
    }
    if (d.users.some(v => String(v.email).toLowerCase() === loginEmail)) {
      showToast('That login email is already in use.');
      return false;
    }

    const doctorId = uid('d');
    const doctor = {
      id: doctorId, name, specialty, experience, fee, availability, slots,
      available, updatedAt: stamp
    };
    const doctorUser = {
      id: uid('doctor-user'), name, email: loginEmail, password: loginPassword,
      phone:'0000000000', role:'doctor', doctorId
    };
    d.doctors.push(doctor);
    d.users.push(doctorUser);

    return commitData(d, 'New doctor saved. The doctor is now visible to patients and can log in.');
  } catch (error) {
    console.error('saveDoctorForm error:', error);
    showToast(`Doctor changes were not saved: ${error.message || 'unexpected error'}`);
    return false;
  }
}

function savePatientForm(form) {
  if (!form) return false;
  try {
    const d = normalizeData(db());
    const field = name => form.elements.namedItem(name);
    const value = name => String(field(name)?.value ?? '').trim();
    const id = value('id');
    const user = d.users.find(q => q.id === id && q.role === 'patient');
    if (!user) {
      showToast('Patient record not found.');
      return false;
    }

    const name = value('name');
    const email = value('email').toLowerCase();
    const phone = value('phone');
    if (!name || !email || !phone) {
      showToast('Name, email, and phone are required.');
      return false;
    }
    if (d.users.some(q => q.id !== id && String(q.email).toLowerCase() === email)) {
      showToast('That email is already in use.');
      return false;
    }

    ensurePatientDefaults(user);
    // Save a complete snapshot BEFORE changing the current record.
    user.profileHistory = Array.isArray(user.profileHistory) ? user.profileHistory : [];
    user.profileHistory.push(snapshotPatient(user));

    Object.assign(user, {
      name,
      email,
      phone,
      age: value('age'),
      gender: value('gender'),
      bloodGroup: value('bloodGroup'),
      address: value('address'),
      emergencyContact: value('emergencyContact')
    });

    // Synchronize the patient's name/email details everywhere the patient is displayed.
    d.appointments.filter(a => a.patientId === id).forEach(a => { a.patientName = user.name; });

    const currentSession = session();
    if (currentSession?.id === id) localStorage.setItem(SESSION_KEY, JSON.stringify(user));

    return commitData(d, 'Patient details saved successfully. Previous data is available in history.');
  } catch (error) {
    console.error('savePatientForm error:', error);
    showToast(`Patient changes were not saved: ${error.message || 'unexpected error'}`);
    return false;
  }
}

document.addEventListener('click', e => {
  const b=e.target.closest('button');
  if(!b)return;

  if(b.dataset.auth){setAuth(b.dataset.auth);return;}
  if(b.dataset.saveDoctor){e.preventDefault();saveDoctorForm(document.getElementById('doctorForm'));return;}
  if(b.dataset.savePatient){e.preventDefault();savePatientForm(document.getElementById('patientForm'));return;}
  if(b.dataset.page){state.page=b.dataset.page;state.search='';render();return;}
  if(b.dataset.action==='book-first'){state.page='doctors';state.search='';render();return;}
  if(b.dataset.action==='add-doctor'){doctorModal();return;}
  if(b.dataset.book){bookingModal(b.dataset.book);return;}
  if(b.dataset.editdoctor){doctorModal(b.dataset.editdoctor);return;}
  if(b.dataset.aiBook){state.page='doctors';state.search='';render();setTimeout(()=>bookingModal(b.dataset.aiBook),50);return;}
  if(b.dataset.aiPrompt){const input=document.getElementById('chatInput');if(input){input.value=b.dataset.aiPrompt;document.getElementById('chatForm')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}return;}
  if(b.dataset.videoCall){videoCallModal(b.dataset.videoCall);return;}
  if(b.dataset.edit){const a=db().appointments.find(x=>x.id===b.dataset.edit);if(a)bookingModal(a.doctorId,a.id);return;}
  if(b.dataset.editpatient){patientEditModal(b.dataset.editpatient);return;}
  if(b.dataset.cancel){const d=db(),a=d.appointments.find(x=>x.id===b.dataset.cancel);if(a){a.status='Cancelled';save(normalizeData(d));showToast('Appointment cancelled.');render();}return;}
  if(b.dataset.complete){const d=db(),a=d.appointments.find(x=>x.id===b.dataset.complete);if(a){a.status='Completed';save(normalizeData(d));showToast('Appointment marked as completed.');render();}return;}
  if(b.dataset.rate){rateModal(b.dataset.rate);return;}
  if(b.dataset.star){
    const picker=b.closest('[data-star-picker]');
    const form=b.closest('form');
    const n=Number(b.dataset.star);
    if(form) form.elements.namedItem('stars').value=n;
    if(picker) [...picker.querySelectorAll('[data-star]')].forEach(btn=>btn.classList.toggle('filled', Number(btn.dataset.star)<=n));
    return;
  }
  if(b.hasAttribute('data-submit-rating')){
    const form=document.getElementById('ratingForm');
    if(form){
      const stars=Number(form.elements.namedItem('stars').value||0);
      const comment=form.elements.namedItem('comment').value;
      const appointmentId=form.elements.namedItem('appointmentId').value;
      submitRating(appointmentId, stars, comment);
    }
    return;
  }
  if(b.dataset.deletedoctor){const d=db();if(d.appointments.some(a=>a.doctorId===b.dataset.deletedoctor&&a.status==='Confirmed')){showToast('Cannot remove a doctor with active appointments.');return;}d.doctors=d.doctors.filter(x=>x.id!==b.dataset.deletedoctor);d.users=d.users.filter(x=>!(x.role==='doctor'&&x.doctorId===b.dataset.deletedoctor));save(normalizeData(d));showToast('Doctor removed from directory and login list.');render();return;}
  if(b.dataset.toggleDoctor){const d=db(),doc=getDoctor(d,b.dataset.toggleDoctor);if(doc){doc.available=doc.available===false;doc.updatedAt=new Date().toISOString();if(doc.available===false){d.appointments.filter(a=>a.doctorId===doc.id&&a.status==='Confirmed'&&a.date>=todayISO()).forEach(a=>{const p=d.users.find(u=>u.id===a.patientId);if(p)createNotification(d,p.id,`Dr. ${doc.name} is unavailable`,`Your booked ${a.mode==='online'?'online consultation':'offline visit'} on ${formatDate(a.date)} at ${a.time} may need rescheduling because the doctor is currently unavailable.`,'warning',`manual-unavailable:${a.id}:${doc.updatedAt}`);});}save(normalizeData(d));showToast(doc.available?'Doctor is now available.':'Doctor marked unavailable; affected patients were notified.');render();}return;}
  if(b.dataset.toggleSelf){const d=db(),doc=getDoctor(d,b.dataset.toggleSelf);if(doc){doc.available=doc.available===false;doc.updatedAt=new Date().toISOString();if(doc.available===false){d.appointments.filter(a=>a.doctorId===doc.id&&a.status==='Confirmed'&&a.date>=todayISO()).forEach(a=>{const p=d.users.find(u=>u.id===a.patientId);if(p)createNotification(d,p.id,`Dr. ${doc.name} is unavailable`,`Your appointment on ${formatDate(a.date)} at ${a.time} is affected because the doctor marked themselves unavailable.`,'warning',`self-unavailable:${a.id}:${doc.updatedAt}`);});}save(normalizeData(d));showToast(doc.available?'You are now available.':'You are marked unavailable; affected patients were notified.');render();}return;}
  if(b.hasAttribute('data-read-all')){const d=db(),u=session();d.notifications.filter(n=>n.userId===u.id).forEach(n=>n.read=true);save(normalizeData(d));showToast('Notifications marked as read.');render();return;}
  if(b.id==='notificationBtn'){state.page='notifications';render();return;}
  if(b.id==='toggleMic'){
    state.callAudioOn=!state.callAudioOn;
    state.callStream?.getAudioTracks().forEach(t=>t.enabled=state.callAudioOn);
    updateCallButtons();return;
  }
  if(b.id==='toggleCam'){
    state.callVideoOn=!state.callVideoOn;
    state.callStream?.getVideoTracks().forEach(t=>t.enabled=state.callVideoOn);
    const fallback=document.getElementById('cameraFallback'); if(fallback && state.callVideoOn && state.callStream) fallback.classList.add('hidden'); if(fallback && !state.callVideoOn) {fallback.textContent='Camera is turned off';fallback.classList.remove('hidden');}
    updateCallButtons();return;
  }
  if(b.id==='endCall'){
    const appointmentId=state.activeCall;
    const d=db(), a=d.appointments.find(x=>x.id===appointmentId), user=session();
    closeModal();
    if(a && a.status==='Confirmed'){ a.status='Completed'; save(normalizeData(d)); }
    render();
    showToast('Video consultation ended.');
    if(user && user.role==='patient' && a){
      setTimeout(()=>rateModal(a.id), 150);
    }
    return;
  }
  if(b.hasAttribute('data-close') || b.id==='closeModal'){closeModal();return;}
  if(b.id==='logoutBtn'){closeModal();localStorage.removeItem(SESSION_KEY);state={page:'dashboard',search:'',filter:'All',chat:[]};render();showToast('You have been logged out.');}
});

document.addEventListener('input', e => {
  if(e.target.matches('[data-search]')){
    const value=e.target.value;state.search=value;render();
    const input=document.querySelector('[data-search]');if(input){input.focus();input.setSelectionRange(value.length,value.length);}
  }
});

document.addEventListener('change', e => {
  if(e.target.matches('[data-filter]')){state.filter=e.target.value;render();return;}
  if(e.target.matches('input[name=signupRole]')){
    const doctorFields=document.getElementById('doctorSignupFields');
    const patientFields=document.getElementById('patientSignupFields');
    const isDoctor=e.target.value==='doctor';
    doctorFields?.classList.toggle('hidden',!isDoctor);
    patientFields?.classList.toggle('hidden',isDoctor);
    const hint=document.getElementById('signupRoleHint');
    if(hint) hint.textContent=isDoctor?'Doctor accounts are added to the directory and can log in separately.':'Patient accounts can find doctors, book visits and use the AI assistant.';
    const requiredIds=['signupSpecialty','signupExperience','signupFee','signupAvailability','signupSlots'];
    requiredIds.forEach(id=>{const el=document.getElementById(id);if(el)el.required=isDoctor;});
    return;
  }
  if(e.target.matches('input[name=mode]')){
    const form=e.target.closest('form');
    const preview=form?.querySelector('#tokenPreview');
    if(preview){
      preview.classList.toggle('hidden',e.target.value!=='offline');
      if(e.target.value==='offline'){
        const doctorId=form.querySelector('input[name=doctorId]')?.value;
        const date=form.querySelector('input[name=date]')?.value || todayISO();
        const appointmentId=form.querySelector('input[name=appointmentId]')?.value || '';
        preview.innerHTML=`🎟 <strong>Offline token:</strong> #${nextOfflineToken(db(),doctorId,date,appointmentId)}`;
      }
    }
    return;
  }
  if(e.target.matches('#bookingForm input[name=date]')){
    const form=e.target.closest('form');if(!form)return;const mode=form.querySelector('input[name=mode]:checked')?.value;const preview=form.querySelector('#tokenPreview');if(mode==='offline'&&preview){const doctorId=form.querySelector('input[name=doctorId]').value;const appointmentId=form.querySelector('input[name=appointmentId]').value;preview.innerHTML=`🎟 <strong>Offline token:</strong> #${nextOfflineToken(db(),doctorId,e.target.value,appointmentId)}`;}
  }
});

document.addEventListener('submit', e => {
  e.preventDefault();
  const f=e.target;

  if(f.id==='loginForm'){
    const d=normalizeData(db()),role=f.loginRole.value,email=f.loginEmail.value.trim().toLowerCase(),password=f.loginPassword.value;
    const u=d.users.find(x=>x.email.toLowerCase()===email&&x.password===password&&x.role===role);
    if(!u){showToast('Incorrect role, email, or password.');return;}
    if(role==='doctor' && !getDoctor(d,u.doctorId)){showToast('Doctor profile not found. Contact Admin.');return;}
    localStorage.setItem(SESSION_KEY,JSON.stringify(u));state={page:'dashboard',search:'',filter:'All',chat:[]};render();showToast(`Welcome back, ${u.name.split(' ')[0]}!`);return;
  }

  if(f.id==='signupForm'){
    const d=normalizeData(db()),role=f.signupRole.value,email=f.signupEmail.value.trim().toLowerCase();
    if(d.users.some(x=>x.email.toLowerCase()===email)){showToast('An account already exists with this email.');return;}
    if(!['patient','doctor'].includes(role)){showToast('Choose Patient or Doctor.');return;}
    const baseUser={name:f.signupName.value.trim(),email,password:f.signupPassword.value,phone:f.signupPhone.value.trim()};
    if(role==='doctor'){
      const doctorId=uid('d');
      const doctor={id:doctorId,name:baseUser.name,specialty:f.signupSpecialty.value.trim()||'General Physician',experience:f.signupExperience.value.trim()||'New practitioner',fee:Number(f.signupFee.value||500),availability:f.signupAvailability.value.trim()||'Mon, Wed, Fri',slots:(f.signupSlots.value||'09:00, 11:00, 16:00').split(',').map(s=>s.trim()).filter(Boolean),available:true,updatedAt:new Date().toISOString()};
      const u={id:uid('doctor-user'),...baseUser,role:'doctor',doctorId};
      d.doctors.push(doctor);d.users.push(u);save(normalizeData(d));localStorage.setItem(SESSION_KEY,JSON.stringify(u));state={page:'dashboard',search:'',filter:'All',chat:[]};render();showToast('Doctor account created. The doctor is now visible to patients and can log in separately.');return;
    }
    const u={id:uid('p'),...baseUser,role:'patient',age:f.signupAge?.value||'',gender:f.signupGender?.value||'',bloodGroup:f.signupBloodGroup?.value.trim()||'',address:f.signupAddress?.value.trim()||'',emergencyContact:f.signupEmergency?.value.trim()||'',profileHistory:[]};
    d.users.push(u);save(normalizeData(d));localStorage.setItem(SESSION_KEY,JSON.stringify(u));state={page:'dashboard',search:'',filter:'All',chat:[]};render();showToast('Patient account created successfully!');return;
  }

  if(f.id==='doctorForm'){ saveDoctorForm(f); return; }

  if(f.id==='patientForm'){ savePatientForm(f); return; }

  if(f.id==='bookingForm'){
    const d=normalizeData(db()),x=Object.fromEntries(new FormData(f)),u=session(),doctor=getDoctor(d,x.doctorId);
    if(!doctor){showToast('Doctor not found.');return;}
    if(doctor.available===false){showToast('This doctor is currently unavailable. Please choose another doctor.');return;}
    const day=new Date(`${x.date}T12:00:00`).toLocaleDateString('en-US',{weekday:'short'});
    const allowedDays=doctor.availability.split(',').map(s=>s.trim().slice(0,3).toLowerCase());
    if(!allowedDays.includes(day.toLowerCase())){showToast(`This doctor is available on ${doctor.availability}.`);return;}
    if(d.appointments.some(a=>a.doctorId===x.doctorId&&a.date===x.date&&a.time===x.time&&a.status==='Confirmed'&&a.id!==x.appointmentId)){showToast('That slot is already booked. Please choose another time.');return;}
    if(x.appointmentId){
      const a=d.appointments.find(q=>q.id===x.appointmentId);if(!a){showToast('Appointment not found.');return;}
      const sameOffline = x.mode==='offline' && a.mode==='offline' && a.doctorId===x.doctorId && a.date===x.date;
      a.mode=x.mode;a.date=x.date;a.time=x.time;a.reason=x.reason;a.tokenNumber=x.mode==='offline' ? (sameOffline ? (a.tokenNumber || nextOfflineToken(d,x.doctorId,x.date,a.id)) : nextOfflineToken(d,x.doctorId,x.date,a.id)) : null;
    } else {
      const token=x.mode==='offline'?nextOfflineToken(d,x.doctorId,x.date):null;
      d.appointments.push({id:uid('a'),doctorId:x.doctorId,date:x.date,time:x.time,reason:x.reason,patientId:u.id,patientName:u.name,status:'Confirmed',mode:x.mode,tokenNumber:token,chat:[]});
    }
    save(normalizeData(d));closeModal();state.page='appointments';render();showToast(x.mode==='online'?'Online appointment confirmed.':'Offline appointment confirmed with token number.');return;
  }

  if(f.id==='chatForm'){
    const input=document.getElementById('chatInput'),message=input.value.trim();if(!message)return;state.chat.push({who:'user',html:esc(message)});state.chat.push({who:'ai',html:aiReply(message)});input.value='';renderChat();input.focus();return;
  }

  if(f.id==='callChatForm'){
    const input=document.getElementById('callChatInput'),message=input.value.trim();if(!message)return;storeCallMessage(message);input.value='';input.focus();return;
  }
});

seedData();
render();

// ---- PWA installability: register the service worker and wire up a
// professional "Install app" prompt (sidebar once signed in, auth screen
// before signing in) instead of a native browser install bar. ----
let deferredInstallPrompt = null;

function isStandaloneDisplay() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updateInstallButtons() {
  const installed = isStandaloneDisplay();
  const authBtn = document.getElementById('installBtnAuth');
  const sideBtn = document.getElementById('installBtnSidebar');
  const show = !!deferredInstallPrompt && !installed;
  authBtn?.classList.toggle('hidden', !show);
  sideBtn?.classList.toggle('hidden', !show);
}

async function promptInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try {
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') showToast('CareConnect is installing…');
  } catch { /* prompt dismissed or unsupported */ }
  deferredInstallPrompt = null;
  updateInstallButtons();
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButtons();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButtons();
  showToast('CareConnect installed! You can now open it like any other app.');
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#installBtnAuth') || e.target.closest('#installBtnSidebar')) promptInstall();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

updateInstallButtons();
