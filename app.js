/* ============ FIREBASE SETUP ============
   1. Go to https://console.firebase.google.com -> Add project
   2. Project settings -> Add a Web App -> copy the config object -> paste it below
   3. Build > Authentication -> Get started -> Sign-in method -> enable "Email/Password"
   4. Build > Firestore Database -> Create database (any region, start in production mode)
   5. Firestore -> Rules -> paste the contents of firestore.rules (provided alongside this file) -> Publish
   6. Open this HTML file. Register your own account first (any role), then in the Firebase
      Console -> Firestore -> users -> open your user document -> manually set role:"admin"
      and status:"approved". That's your one-time admin bootstrap step. Every other rule
      already correctly requires admin approval, so this manual step is done on purpose —
      it's what keeps random visitors from being able to grant themselves admin.
*/
const firebaseConfig = {
  apiKey: "AIzaSyCt6s5nMB4bS6_tKYOu8U5ERH7-Y9yP9qU",
  authDomain: "prephub-f9dbd.firebaseapp.com",
  projectId: "prephub-f9dbd",
  storageBucket: "prephub-f9dbd.firebasestorage.app",
  messagingSenderId: "63924321576",
  appId: "1:63924321576:web:b1840e34337b3b8771641d",
  measurementId: "G-HYQJVRPV73"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const analytics = firebase.analytics();
// App Check — verifies requests come from your real site, not a bot/scraper
const appCheck = firebase.appCheck();
appCheck.activate('6LekOHstAAAAAPAzWGFDXS8oAKrt4M7jRuoXJ1rf', true); // true = auto-refresh tokens

const dbFS = firebase.firestore();
// Each browser tab gets its own independent login instead of sharing one login
// across every open tab. Trade-off: closing a tab and opening a fresh one means
// logging in again (a refresh of the SAME tab stays logged in fine) — but it lets
// you have an admin logged in in one tab and a teacher logged in in another at
// the same time, which is useful for testing and keeps roles from bleeding
// across tabs.
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});

/* ============ STORAGE / STATE ============
   DB is now a live local mirror of Firestore, kept in sync by onSnapshot listeners.
   All the render functions below still read DB.users / DB.tests / etc. synchronously
   exactly like before — only the write path (create/update/delete) goes through Firestore.
*/
let DB={users:[],directory:[],schools:[],classes:[],tests:[],attempts:[],tickets:[],conversations:[],groupChats:[],groupInvites:[],studyMaterials:[],polls:[],pollVotes:[],materialComments:[]};
let currentProfile=null;
let uiState={sidebarCollapsed:false, page:'dashboard', pageParams:{}};
let privateListeners=[], publicListeners=[];
let studyMaterialsListener=null, pollsListener=null;
let materialCommentListeners={}, pollVoteListeners={};
let privatePermissionHandled=false;
let directoryBackfillStarted=false;

function uid(pre){return (pre||'id')+'_'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);}
function nowISO(){return new Date().toISOString();}
function fmtDate(iso){if(!iso)return '—';const d=new Date(iso);return d.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}

function friendlyError(e){
  const map={
    'auth/email-already-in-use':'That email is already registered.',
    'auth/invalid-email':'That email address looks invalid.',
    'auth/weak-password':'Password is too weak (use at least 6 characters).',
    'auth/wrong-password':'Invalid email or password.',
    'auth/user-not-found':'Invalid email or password.',
    'auth/invalid-credential':'Invalid email or password.',
    'auth/requires-recent-login':'Please log out and log back in, then try again.',
    'auth/network-request-failed':'Network error — check your connection and try again.',
    'permission-denied':'You do not have permission to do that.'
  };
  return map[e.code] || e.message || 'Something went wrong.';
}
function handlePrivateSyncError(area,e){
  // One denied Firestore request can make several listeners fail at once.
  // Show the actual account-state problem once instead of stacking popups.
  if(e && e.code==='permission-denied'){
    if(privatePermissionHandled)return;
    privatePermissionHandled=true;
    toast('Your signed-in account is not approved for app data. Ask an admin to set its user status to "approved".','warn');
    return;
  }
  toast('Sync error ('+area+'): '+friendlyError(e),'error');
}

// Optimistic local-cache helpers so the UI updates instantly after a write succeeds,
// without waiting for the round-trip through the onSnapshot listener.
function localUpsert(coll,id,data){
  const arr=DB[coll]; const idx=arr.findIndex(x=>x.id===id);
  const obj={id,...data};
  if(idx>-1) arr[idx]=obj; else arr.push(obj);
}
function localUpdate(coll,id,patch){
  const arr=DB[coll]; const idx=arr.findIndex(x=>x.id===id);
  if(idx>-1) Object.assign(arr[idx],patch);
}
function localRemove(coll,id){ DB[coll]=DB[coll].filter(x=>x.id!==id); }

async function backfillUserDirectory(){
  if(directoryBackfillStarted||!currentProfile||currentProfile.role!=='admin')return;
  directoryBackfillStarted=true;
  try{
    const batch=dbFS.batch();
    DB.users.forEach(u=>batch.set(dbFS.collection('userDirectory').doc(u.id),{
      name:u.name||'',role:u.role||'',school:u.school||'',cls:u.cls||'',status:u.status||'pending'
    },{merge:true}));
    await batch.commit();
  }catch(e){ directoryBackfillStarted=false; toast('Could not prepare the secure contact directory: '+friendlyError(e),'error'); }
}

/* ---- Public data needed before login (schools/classes for the registration form) ---- */
function attachPublicListeners(){
  publicListeners.push(dbFS.collection('schools').onSnapshot(snap=>{
    DB.schools=snap.docs.map(d=>({id:d.id,...d.data()}));
    populateRegSelects();
    if(currentProfile) refreshUI();
  }, e=>toast('Could not load schools: '+friendlyError(e),'error')));
  publicListeners.push(dbFS.collection('classes').onSnapshot(snap=>{
    DB.classes=snap.docs.map(d=>({id:d.id,...d.data()}));
    populateRegSelects();
    if(currentProfile) refreshUI();
  }, e=>toast('Could not load classes: '+friendlyError(e),'error')));
}

/* ---- Private data, only after a successful approved login ---- */
function attachPrivateListeners(){
  detachPrivateListeners();
  privatePermissionHandled=false;
  // Do not make every regular user subscribe to the complete user directory at
  // login. Besides exposing more data than the dashboard needs, that query is
  // rejected by common Firestore rules that only allow a user to read their own
  // profile. Admins still receive the full live directory for account management.
  const usersQuery = currentProfile.role==='admin'
    ? dbFS.collection('users')
    : dbFS.collection('users').doc(currentProfile.id);
  privateListeners.push(usersQuery.onSnapshot(snap=>{
    DB.users = currentProfile.role==='admin'
      ? snap.docs.map(d=>({id:d.id,...d.data()}))
      : (snap.exists ? [{id:snap.id,...snap.data()}] : []);
    if(currentProfile.role==='admin') backfillUserDirectory();
    // If this account gets suspended, rejected, or deleted mid-session, sign out.
    if(currentProfile && !DB.users.some(u=>u.id===currentProfile.id && u.status==='approved')){
      toast('Your account access has changed. Please log in again.','warn');
      doLogout();
      return;
    }
    refreshUI();
  }, e=>handlePrivateSyncError('profile',e)));
  // Contact cards live separately from full profiles, so messaging never needs
  // access to email addresses, phone numbers, or approval history. Visibility
  // is NOT school-scoped (see firestore.rules) — the New Message picker lets
  // anyone message anyone, so every approved user needs the full directory.
  // Admins additionally see non-approved cards (pending/rejected) for account
  // management, so they still get the unfiltered collection.
  function onDirectoryUpdated(){
    refreshUI();
    if(uiState.page==='messages'){
      renderConvoList();
      if(chatState.mode==='direct' && chatState.otherUserId){
        const other=userById(chatState.otherUserId);
        const headerEl=document.getElementById('chatHeader');
        if(headerEl) headerEl.innerHTML='<span>'+esc(other?other.name:'Unknown user')+' <span style="font-weight:400;color:var(--ink4);font-size:.8rem;">('+esc(other?other.role:'')+')</span></span>';
      }
      const nc=document.getElementById('newChatList');
      if(nc && typeof filterNewChatList==='function') filterNewChatList();
    }
  }
  const directoryQuery=currentProfile.role==='admin'
    ? dbFS.collection('userDirectory')
    : dbFS.collection('userDirectory').where('status','==','approved');
  privateListeners.push(directoryQuery.onSnapshot(snap=>{
    DB.directory=snap.docs.map(d=>({id:d.id,...d.data()}));
    onDirectoryUpdated();
  }, e=>handlePrivateSyncError('directory',e)));
  privateListeners.push(dbFS.collection('tests').onSnapshot(snap=>{
    DB.tests=snap.docs.map(d=>({id:d.id,...d.data()}));
    refreshUI();
  }, e=>handlePrivateSyncError('tests',e)));
  privateListeners.push(dbFS.collection('attempts').onSnapshot(snap=>{
    DB.attempts=snap.docs.map(d=>({id:d.id,...d.data()}));
    refreshUI();
  }, e=>handlePrivateSyncError('attempts',e)));
  // The tickets rule allows a read either if you're an admin, or if it's your
  // OWN ticket (resource.data.userId == your uid). Firestore can only allow an
  // unfiltered list() query when the rule can be proven safe purely from what
  // the query itself constrains — for a non-admin, "is it my own ticket" isn't
  // something an unfiltered query can prove, so listening to the whole
  // collection with no filter got rejected with permission-denied for every
  // teacher/student (admins "worked" only because isAdmin() alone doesn't
  // depend on resource data). Query the right thing for each role instead:
  // admins listen to everything, everyone else only to their own tickets.
  const ticketsQuery = (currentProfile.role==='admin')
    ? dbFS.collection('tickets')
    : dbFS.collection('tickets').where('userId','==',currentProfile.id);
  privateListeners.push(ticketsQuery.onSnapshot(snap=>{
    DB.tickets=snap.docs.map(d=>({id:d.id,...d.data()}));
    buildNav();
    // 'support' and 'supporttickets' sit in refreshUI's skip list (a full page
    // re-render there would blank out whatever reply someone is mid-typing), so
    // patch just the ticket list/cards directly instead, same pattern as messages.
    if(uiState.page==='support'){
      const u=currentUser();
      const wrap=document.getElementById('myTicketsWrap');
      if(u && wrap){
        const myTickets=[...DB.tickets].filter(t=>t.userId===u.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        wrap.innerHTML = myTickets.length? myTickets.map(t=>myTicketCardHTML(t)).join('') : '<div class="empty"><div class="e-icon">🗂️</div><div class="e-title">No queries yet</div><div class="e-sub">Anything you raise will show up here.</div></div>';
      }
    } else if(uiState.page==='supporttickets'){
      if(document.getElementById('ticketsList')) renderTicketsList();
    } else {
      refreshUI();
    }
  }, e=>handlePrivateSyncError('tickets',e)));
  privateListeners.push(dbFS.collection('conversations').where('participants','array-contains',currentProfile.id).onSnapshot(snap=>{
    DB.conversations=snap.docs.map(d=>({id:d.id,...d.data()}));
    buildNav();
    // Messages is excluded from refreshUI's full-page re-render (it would wipe
    // whatever the person is mid-typing into the message box), so update just
    // the conversation list sidebar directly instead.
    if(uiState.page==='messages') renderConvoList();
  }, e=>handlePrivateSyncError('messages',e)));
  privateListeners.push(dbFS.collection('groupChats').where('participants','array-contains',currentProfile.id).onSnapshot(snap=>{
    DB.groupChats=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(uiState.page==='messages') renderGroupList();
  }, e=>handlePrivateSyncError('groups',e)));
  // Groups I've been invited to but haven't accepted/declined yet — a separate
  // query since it's keyed off a different array field (`invites`, not
  // `participants`). Nobody is ever dropped straight into a group's member
  // list; this is what lets them see the invite and accept or decline it.
  privateListeners.push(dbFS.collection('groupChats').where('invites','array-contains',currentProfile.id).onSnapshot(snap=>{
    DB.groupInvites=snap.docs.map(d=>({id:d.id,...d.data()}));
    buildNav();
    if(uiState.page==='messages') renderGroupList();
  }, e=>handlePrivateSyncError('group invites',e)));
}
function detachPrivateListeners(){
  privateListeners.forEach(u=>u()); privateListeners=[];
  [studyMaterialsListener,pollsListener].forEach(u=>{if(u)u();});
  Object.values(materialCommentListeners).forEach(u=>u());
  Object.values(pollVoteListeners).forEach(u=>u());
  studyMaterialsListener=null;pollsListener=null;materialCommentListeners={};pollVoteListeners={};
  if(chatState.msgUnsub){ chatState.msgUnsub(); chatState.msgUnsub=null; }
  chatState.otherUserId=null; chatState.messages=[];
  chatState.mode='direct'; chatState.groupId=null; chatState.groupMessages=[];
  DB.groupInvites=[];
}

// Re-renders the nav (badges) and, when it's safe to do so, the current page.
// Pages with in-progress form input (creating/editing a test, mid-attempt) are left
// alone so a background sync never wipes out what the user is typing.
function refreshUI(){
  if(!currentProfile) return;
  buildNav();
  const skipAutoRerender=['createtest','edittest','testrunner','messages','support','supporttickets'];
  if(!skipAutoRerender.includes(uiState.page)) render();
}

function currentUser(){
  if(!currentProfile) return null;
  return DB.users.find(u=>u.id===currentProfile.id) || currentProfile;
}

/* ---- Auth state is the single source of truth for whether we're "logged in" ---- */
// While doRegister() is in the middle of creating the auth account and then
// writing its Firestore profile, Firebase fires onAuthStateChanged immediately
// after the account is created — before that profile document exists yet. Left
// unguarded, this listener would see "no profile", show "Account not found",
// and sign the brand-new user straight back out mid-registration. This flag
// tells the listener to sit out that narrow window; doRegister() drives the
// UI itself once its own write finishes (see checkUserProfileAndEnter below).
let registrationInFlight=false;

async function checkUserProfileAndEnter(user){
  try{
    // Make sure Firestore has the current sign-in credential before attaching
    // listeners. This avoids an initial permission-denied race immediately
    // after an email/password login in slower browser sessions.
    await user.getIdToken();
    const snap=await dbFS.collection('users').doc(user.uid).get();
    if(!snap.exists){
      toast('Account not found. Contact admin.','error');
      await auth.signOut();
      return;
    }
    const profile={id:snap.id,...snap.data()};
    // This must match isApproved() in firestore.rules exactly. Previously any
    // unexpected status (for example missing, "active", or "Approved") entered
    // the app, where every listener was then denied by Firestore.
    if(profile.status!=='approved'){
      const message=profile.status==='pending'
        ? 'Your account is pending admin approval.'
        : profile.status==='rejected'
          ? 'Your registration was rejected. Contact an admin.'
          : 'Your account is not approved yet. Ask an admin to set its status to "approved".';
      toast(message,profile.status==='rejected'?'error':'warn');
      await auth.signOut();
      return;
    }
    currentProfile=profile;
    attachPrivateListeners();
    enterApp();
  }catch(e){
    toast('Failed to load your profile: '+friendlyError(e),'error');
    await auth.signOut();
  }
}

auth.onAuthStateChanged(async (user)=>{
  if(!user){
    currentProfile=null;
    detachPrivateListeners();
    DB.users=[];DB.directory=[];DB.tests=[];DB.attempts=[];DB.tickets=[];DB.groupChats=[];DB.groupInvites=[];DB.studyMaterials=[];DB.polls=[];DB.pollVotes=[];DB.materialComments=[];
    directoryBackfillStarted=false;
    document.getElementById('shell').classList.remove('show');
    const authEl=document.getElementById('authScreen');
    authEl.classList.remove('hide');
    authEl.style.display='flex';
    return;
  }
  if(registrationInFlight) return; // doRegister() will call checkUserProfileAndEnter itself when ready
  await checkUserProfileAndEnter(user);
});

/* ============ TOAST ============ */
function toast(msg,type){
  type=type||'info';
  const el=document.createElement('div');
  el.className='toast-msg '+type;
  const icons={success:'✅',error:'⛔',info:'ℹ️',warn:'⚠️'};
  el.innerHTML='<span>'+(icons[type]||'')+'</span><span>'+msg+'</span>';
  document.getElementById('toast').appendChild(el);
  setTimeout(()=>el.remove(),3000);
}

/* ============ CONFIRM MODAL ============ */
function openConfirm(title,sub,onYes,dangerLabel){
  document.getElementById('confirmTitle').textContent=title;
  document.getElementById('confirmSub').textContent=sub||'';
  const btn=document.getElementById('confirmActionBtn');
  btn.textContent=dangerLabel||'Confirm';
  btn.onclick=function(){onYes();closeConfirm();};
  document.getElementById('confirmOverlay').classList.remove('hidden');
}
function closeConfirm(){document.getElementById('confirmOverlay').classList.add('hidden');}

/* ============ DARK MODE ============ */
function toggleDark(){
  document.body.classList.toggle('dark');
  localStorage.setItem('prephub_dark', document.body.classList.contains('dark')?'1':'0');
}
function initDark(){ if(localStorage.getItem('prephub_dark')==='1') document.body.classList.add('dark'); }

/* ============ SIDEBAR ============ */
function toggleSidebar(){
  uiState.sidebarCollapsed=!uiState.sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed',uiState.sidebarCollapsed);
}

/* ============ AUTH SCREEN LOGIC ============ */
let regRole='teacher';
function switchAuthTab(t){
  document.getElementById('tabLoginBtn').classList.toggle('active',t==='login');
  document.getElementById('tabRegisterBtn').classList.toggle('active',t==='register');
  document.getElementById('loginPane').style.display=t==='login'?'block':'none';
  document.getElementById('registerPane').style.display=t==='register'?'block':'none';
  if(t==='register') populateRegSelects();
}
function pickRole(r){
  regRole=r;
  document.getElementById('roleOptTeacher').classList.toggle('active',r==='teacher');
  document.getElementById('roleOptStudent').classList.toggle('active',r==='student');
  document.getElementById('regSubjectField').style.display=r==='teacher'?'block':'none';
}
function togglePw(id){
  const el=document.getElementById(id);
  el.type=el.type==='password'?'text':'password';
}
function populateRegSelects(){
  const s=document.getElementById('regSchool'), c=document.getElementById('regClass');
  const noSchool='<option value="">Not assigned yet (admin can add later)</option>';
  const noClass='<option value="">Not assigned yet (admin can add later)</option>';
  s.innerHTML=noSchool+DB.schools.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');
  c.innerHTML=noClass+DB.classes.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');
}
function esc(s){return (s==null?'':String(s)).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

async function doRegister(){
  const name=document.getElementById('regName').value.trim();
  const email=document.getElementById('regEmail').value.trim().toLowerCase();
  const pw=document.getElementById('regPassword').value;
  const phone=document.getElementById('regPhone').value.trim();
  const school=document.getElementById('regSchool').value;
  const cls=document.getElementById('regClass').value;
  const subject=document.getElementById('regSubject').value.trim();
  if(!name||!email||!pw){toast('Please fill all required fields','error');return;}
  if(pw.length<6){toast('Password must be at least 6 characters','error');return;}
  // School/Class are optional now — an admin can be assigned to one later, and
  // this also avoids the old chicken-and-egg bug where the very first person
  // (who needs to register in order to become admin) couldn't register at all
  // because no school/class existed yet for them to pick from.
  const btn=document.getElementById('registerBtn');
  if(btn){btn.disabled=true; btn.textContent='Creating account...';}
  try{
    registrationInFlight=true; // must be set before the await below, not after — awaiting yields
    // control to the browser, and Firebase's own auth listener can otherwise fire and race ahead
    // of this line, signing the brand-new account back out before we get a chance to set the flag.
    const cred=await auth.createUserWithEmailAndPassword(email,pw);
    const baseProfile={name,email,school,cls,phone,subject:regRole==='teacher'?subject:'',createdAt:nowISO()};
    const userRef=dbFS.collection('users').doc(cred.user.uid);
    const directoryRef=dbFS.collection('userDirectory').doc(cred.user.uid);
    const bootstrapRef=dbFS.collection('system').doc('bootstrap');
    let becameAdmin=false;
    try{
      // Bootstrap: if no admin has ever been created on this project yet, the very
      // first person to register is automatically made an approved admin — solving
      // the manual-Firestore-edit chicken-and-egg problem. This is done inside a
      // transaction guarded by security rules so only one registrant can ever win
      // this race, and every registrant after that follows the normal pending flow.
      await dbFS.runTransaction(async(tx)=>{
        const bs=await tx.get(bootstrapRef);
        if(!bs.exists || bs.data().adminCreated!==true){
          becameAdmin=true;
          tx.set(userRef,{...baseProfile,role:'admin',status:'approved'});
          tx.set(directoryRef,{name,role:'admin',school,cls,status:'approved'});
          tx.set(bootstrapRef,{adminCreated:true,adminUid:cred.user.uid,adminEmail:email,at:nowISO()});
        }else{
          tx.set(userRef,{...baseProfile,role:regRole,status:'pending'});
          tx.set(directoryRef,{name,role:regRole,school,cls,status:'pending'});
        }
      });
    }catch(profileErr){
      // The auth account was created but the profile write got rejected (e.g. rules
      // not published yet). Don't leave an orphaned login behind — undo the auth
      // account so the person can simply try registering again with the same email.
      await cred.user.delete().catch(()=>{});
      throw profileErr;
    }finally{
      registrationInFlight=false;
    }
    if(becameAdmin){
      toast('You are the first account here — you have been made admin automatically. Logging you in…','success');
      await checkUserProfileAndEnter(cred.user); // the listener sat this out, so drive login ourselves
    }else{
      await auth.signOut(); // registering doesn't log you in — you need admin approval first
      toast('Registered! Please wait for admin approval.','success');
      switchAuthTab('login');
      document.getElementById('loginEmail').value=email;
    }
    document.getElementById('regName').value='';document.getElementById('regEmail').value='';document.getElementById('regPassword').value='';document.getElementById('regPhone').value='';document.getElementById('regSubject').value='';
  }catch(e){
    registrationInFlight=false;
    toast(friendlyError(e),'error');
  }finally{
    if(btn){btn.disabled=false; btn.textContent='Create Account';}
  }
}

async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim().toLowerCase();
  const pw=document.getElementById('loginPassword').value;
  if(!email||!pw){toast('Enter your email and password','error');return;}
  const btn=document.getElementById('loginBtn');
  if(btn){btn.disabled=true; btn.textContent='Logging in...';}
  try{
    await auth.signInWithEmailAndPassword(email,pw);
    // onAuthStateChanged picks it up from here: fetches the profile, checks
    // status, and either calls enterApp() or signs back out with a toast.
  }catch(e){
    toast(friendlyError(e),'error');
  }finally{
    if(btn){btn.disabled=false; btn.textContent='Log In';}
  }
}
function doLogout(){
  auth.signOut();
  document.getElementById('loginEmail').value='';document.getElementById('loginPassword').value='';
}

/* ============ APP ENTRY ============ */
function enterApp(){
  const u=currentUser();
  const authEl=document.getElementById('authScreen');
  authEl.classList.add('hide'); // triggers the opacity fade defined in styles.css
  setTimeout(()=>{ authEl.style.display='none'; },280);
  document.getElementById('shell').classList.add('show');
  document.getElementById('sbAvatar').textContent=u.name.charAt(0).toUpperCase();
  document.getElementById('sbName').textContent=u.name;
  document.getElementById('sbRole').textContent=u.role.charAt(0).toUpperCase()+u.role.slice(1);
  document.getElementById('tbAvatarBtn').textContent=u.name.charAt(0).toUpperCase();
  buildNav();
  goPage(u.role==='admin'?'dashboard':'dashboard');
}
function buildNav(){
  const u=currentUser();
  const pendingCount=DB.users.filter(x=>x.status==='pending').length;
  const inviteCount=(DB.groupInvites||[]).length;
  let items=[];
  if(u.role==='admin'){
    items=[
      {sec:'Overview'},
      {p:'dashboard',icon:'📊',label:'Dashboard'},
      {sec:'Administration'},
      {p:'approvals',icon:'✅',label:'Pending Approvals',badge:pendingCount||null},
      {p:'users',icon:'👥',label:'Manage Users'},
      {p:'registry',icon:'🏫',label:'Schools & Classes'},
      {sec:'Tests'},
      {p:'alltests',icon:'📝',label:'All Tests'},
      {p:'analytics',icon:'📈',label:'Analytics'},
      {sec:'Learning'},
      {p:'materials',icon:'📚',label:'Study Materials'},
      {p:'examprep',icon:'✍️',label:'Exam Prep Guides'},
      {p:'polls',icon:'🗳️',label:'Class Polls'},
      {p:'aidoubt',icon:'🤖',label:'AI Doubt Solving',badgeText:'Soon'},
      {sec:'Support'},
      {p:'supporttickets',icon:'🆘',label:'Support Tickets',badge:openTicketCount()||null},
      {p:'messages',icon:'💬',label:'Messages',badge:inviteCount||null},
      {sec:''},
      {p:'profile',icon:'⚙️',label:'My Profile'}
    ];
  } else if(u.role==='teacher'){
    items=[
      {sec:'Overview'},
      {p:'dashboard',icon:'📊',label:'Dashboard'},
      {sec:'Tests & DPP'},
      {p:'createtest',icon:'➕',label:'Create Test / DPP'},
      {p:'mytests',icon:'📝',label:'My Tests'},
      {p:'analytics',icon:'📈',label:'Analytics'},
      {sec:'Learning'},
      {p:'materials',icon:'📚',label:'Study Materials'},
      {p:'examprep',icon:'✍️',label:'Exam Prep Guides'},
      {p:'polls',icon:'🗳️',label:'Class Polls'},
      {p:'aidoubt',icon:'🤖',label:'AI Doubt Solving',badgeText:'Soon'},
      {sec:'Support'},
      {p:'support',icon:'🆘',label:'Help & Support'},
      {p:'messages',icon:'💬',label:'Messages',badge:inviteCount||null},
      {sec:''},
      {p:'profile',icon:'⚙️',label:'My Profile'}
    ];
  } else {
    items=[
      {sec:'Overview'},
      {p:'dashboard',icon:'📊',label:'Dashboard'},
      {sec:'Tests'},
      {p:'available',icon:'📥',label:'Available Tests'},
      {p:'results',icon:'🏆',label:'My Results'},
      {p:'analytics',icon:'📈',label:'My Analytics'},
      {p:'progress',icon:'🎯',label:'My Progress'},
      {sec:'Learning'},
      {p:'materials',icon:'📚',label:'Study Materials'},
      {p:'examprep',icon:'✍️',label:'Exam Prep Guides'},
      {p:'polls',icon:'🗳️',label:'Class Polls'},
      {p:'aidoubt',icon:'🤖',label:'AI Doubt Solving',badgeText:'Soon'},
      {sec:'Support'},
      {p:'support',icon:'🆘',label:'Help & Support'},
      {p:'messages',icon:'💬',label:'Messages',badge:inviteCount||null},
      {sec:''},
      {p:'profile',icon:'⚙️',label:'My Profile'}
    ];
  }
  const nav=document.getElementById('navArea');
  nav.innerHTML=items.map(it=>{
    if(it.sec!==undefined) return it.sec? '<div class="sb-section">'+it.sec+'</div>':'<div class="sb-divider"></div>';
    const badgeHTML = it.badgeText ? '<div class="sb-badge sb-badge-soon">'+it.badgeText+'</div>' : (it.badge?'<div class="sb-badge">'+it.badge+'</div>':'');
    return '<div class="sb-item" data-page="'+it.p+'" onclick="goPage(\''+it.p+'\')"><div class="sb-icon">'+it.icon+'</div><div class="sb-label">'+it.label+'</div>'+badgeHTML+'</div>';
  }).join('');
}
function markActiveNav(page){
  document.querySelectorAll('.sb-item').forEach(el=>el.classList.toggle('active', el.dataset.page===page));
}

/* ============ ROUTER ============ */
function goPage(page,params){
  uiState.page=page; uiState.pageParams=params||{};
  markActiveNav(page);
  const titles={dashboard:'Dashboard',approvals:'Pending Approvals',users:'Manage Users',registry:'Schools & Classes',
    alltests:'All Tests',analytics:'Analytics',createtest:'Create Test / DPP',mytests:'My Tests',available:'Available Tests',
    results:'My Results',profile:'My Profile',testrunner:'Attempt Test',testreview:'Test Review',testanalytics:'Test Analytics',edittest:'Edit Test',
    support:'Help & Support',supporttickets:'Support Tickets',messages:'Messages',materials:'Study Materials',examprep:'Exam Prep Guides',polls:'Class Polls',progress:'My Progress',aidoubt:'AI Doubt Solving'};
  document.getElementById('pageTitle').textContent=titles[page]||'PrepHub';
  render();
}
function render(){
  const u=currentUser(); if(!u) return;
  const c=document.getElementById('content');
  const fns={
    dashboard: u.role==='admin'?renderAdminDashboard: u.role==='teacher'?renderTeacherDashboard:renderStudentDashboard,
    approvals: renderApprovals,
    users: renderUsers,
    registry: renderRegistry,
    alltests: renderAllTests,
    analytics: u.role==='student'?renderStudentAnalytics: u.role==='teacher'?renderTeacherAnalytics:renderAdminAnalytics,
    createtest: renderCreateTest,
    mytests: renderMyTests,
    available: renderAvailableTests,
    results: renderMyResults,
    profile: renderProfile,
    testrunner: renderTestRunner,
    testreview: renderTestReview,
    testanalytics: renderTestAnalytics,
    edittest: renderCreateTest,
    support: renderSupport,
    supporttickets: renderSupportTickets,
    messages: renderMessages,
    materials: (el)=>renderLearningResources(el,'material'),
    examprep: (el)=>renderLearningResources(el,'exam-prep'),
    polls: renderPolls,
    progress: renderStudentProgress,
    aidoubt: renderAiDoubt
  };
  c.innerHTML='';
  (fns[uiState.page]||renderNotFound)(c);
}
function renderNotFound(c){c.innerHTML='<div class="empty"><div class="e-icon">🤷</div><div class="e-title">Page not found</div></div>';}

/* ---- AI Doubt Solving: placeholder page, feature coming soon ---- */
function renderAiDoubt(c){
  c.innerHTML=`
  <div class="page-header"><h2>🤖 AI Doubt Solving</h2><p>Ask a question, get an instant AI-powered explanation.</p></div>
  <div class="card" style="text-align:center;padding:56px 24px;">
    <div style="font-size:3rem;margin-bottom:14px;">🚧</div>
    <div style="font-family:'Crimson Pro',serif;font-size:1.5rem;font-weight:600;color:var(--ink);margin-bottom:8px;">In Development — Coming Soon</div>
    <div style="color:var(--ink3);font-size:.88rem;max-width:440px;margin:0 auto;line-height:1.6;">
      We're building an AI doubt-solving assistant so you'll be able to ask questions
      here and get instant, step-by-step explanations. Hang tight — it's on the way!
    </div>
    <div style="margin-top:22px;"><span class="badge b-pending">⏳ Coming Soon (It may take upto months)</span></div>
  </div>`;
}

/* ============ HELPERS: DATA ============ */
function schoolName(id){const s=DB.schools.find(x=>x.id===id);return s?s.name:'—';}
function className(id){const c=DB.classes.find(x=>x.id===id);return c?c.name:'—';}
function userById(id){return DB.users.find(x=>x.id===id)||DB.directory.find(x=>x.id===id);}
function contactDirectory(){
  const me=currentUser();
  // An admin already has permission to see the full user list. Use it as a
  // safe migration fallback until the minimal directory has been populated.
  const source=me.role==='admin' ? DB.users : DB.directory;
  return source.filter(u=>u.status==='approved'&&u.id!==me.id);
}
function testById(id){return DB.tests.find(x=>x.id===id);}
function testAttempts(testId){return DB.attempts.filter(a=>a.testId===testId);}
function userAttempts(userId){return DB.attempts.filter(a=>a.userId===userId);}
function maxScoreOf(test){return test.questions.reduce((s,q)=>s+Number(q.marks||1),0);}

function classFilterOptions(selected){
  return ['<option value="ALL">All Classes</option>'].concat(DB.classes.map(cl=>'<option value="'+cl.id+'"'+(selected===cl.id?' selected':'')+'>'+esc(cl.name)+'</option>')).join('');
}
function matchesClass(item,selected){return selected==='ALL'||!item.cls||item.cls==='ALL'||item.cls===selected;}
function matchesSearch(item,search){return !search||[item.title,item.subject,item.description].join(' ').toLowerCase().includes(search.toLowerCase());}

/* ============ STUDY MATERIALS & EXAM PREP ============ */
let learningUploadData='';
let learningEditUploadData='';

function ensureStudyMaterialsListener(){
  if(studyMaterialsListener)return;
  studyMaterialsListener=dbFS.collection('studyMaterials').onSnapshot(snap=>{
    DB.studyMaterials=snap.docs.map(d=>({id:d.id,...d.data()}));
    syncMaterialCommentListeners();
    if(uiState.page==='materials'||uiState.page==='examprep'||uiState.page==='progress')render();
  },e=>handlePrivateSyncError('study materials',e));
}
function syncMaterialCommentListeners(){
  const materialIds=new Set(DB.studyMaterials.map(x=>x.id));
  Object.keys(materialCommentListeners).forEach(id=>{
    if(!materialIds.has(id)){
      materialCommentListeners[id](); delete materialCommentListeners[id];
      DB.materialComments=DB.materialComments.filter(c=>c.materialId!==id);
    }
  });
  materialIds.forEach(materialId=>{
    if(materialCommentListeners[materialId])return;
    materialCommentListeners[materialId]=dbFS.collection('studyMaterials').doc(materialId).collection('comments').onSnapshot(snap=>{
      const comments=snap.docs.map(d=>({id:d.id,...d.data(),materialId}));
      DB.materialComments=DB.materialComments.filter(c=>c.materialId!==materialId).concat(comments);
      refreshMaterialDiscussion(materialId);
      if(uiState.page==='materials'||uiState.page==='examprep')render();
    },e=>handlePrivateSyncError('material questions',e));
  });
}
function ensurePollListeners(){
  if(!pollsListener)pollsListener=dbFS.collection('polls').onSnapshot(snap=>{
    DB.polls=snap.docs.map(d=>({id:d.id,...d.data()}));syncPollVoteListeners();if(uiState.page==='polls')render();
  },e=>handlePrivateSyncError('polls',e));
}
function syncPollVoteListeners(){
  const pollIds=new Set(DB.polls.map(x=>x.id));
  Object.keys(pollVoteListeners).forEach(id=>{
    if(!pollIds.has(id)){
      pollVoteListeners[id](); delete pollVoteListeners[id];
      DB.pollVotes=DB.pollVotes.filter(v=>v.pollId!==id);
    }
  });
  pollIds.forEach(pollId=>{
    if(pollVoteListeners[pollId])return;
    pollVoteListeners[pollId]=dbFS.collection('polls').doc(pollId).collection('votes').onSnapshot(snap=>{
      const votes=snap.docs.map(d=>({id:d.id,...d.data(),pollId}));
      DB.pollVotes=DB.pollVotes.filter(v=>v.pollId!==pollId).concat(votes);
      if(uiState.page==='polls')render();
    },e=>handlePrivateSyncError('poll votes',e));
  });
}

function renderLearningResources(c,category){
  ensureStudyMaterialsListener();
  const isPrep=category==='exam-prep';
  const title=isPrep?'Exam Prep Guides':'Study Materials';
  const intro=isPrep
    ? 'Teacher-curated important topics, composition guidance and exam preparation documents.'
    : 'Notes and PDFs shared by your teachers for class study.';
  window._learningClassFilters=window._learningClassFilters||{};
  const classFilter=window._learningClassFilters[category]||'ALL';
  window._learningSearches=window._learningSearches||{};
  const search=(window._learningSearches[category]||'').toLowerCase();
  const items=DB.studyMaterials.filter(x=>x.category===category && matchesClass(x,classFilter) && (!search||[x.title,x.subject,x.description].join(' ').toLowerCase().includes(search)))
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const teacher=currentUser().role==='teacher';
  const composer=teacher?`
    <div class="card" style="margin-bottom:18px;">
      <div class="card-header"><div><h3>${isPrep?'Share an exam prep guide':'Add study material'}</h3><p style="font-size:.78rem;color:var(--ink3);margin-top:3px;">Write a document here or attach a PDF (up to 500 KB).</p></div></div>
      <div class="g2"><div class="field"><label>Title <span class="req">*</span></label><input id="learningTitle" maxlength="120" placeholder="e.g. Important chapters for the final exam"></div>
      <div class="field"><label>Subject</label><input id="learningSubject" maxlength="100" placeholder="e.g. English"></div></div>
      <div class="field"><label>Target class <span class="req">*</span></label><select id="learningClass">${classFilterOptions('ALL')}</select><div class="hint">Select a class, or choose All Classes to share it with everyone.</div></div>
      <div class="field"><label>Short description</label><input id="learningDescription" maxlength="300" placeholder="What will students find in this material?"></div>
      <div class="field"><label>Written document</label><textarea id="learningText" maxlength="40000" placeholder="Write notes, important topics, composition instructions or a preparation plan here…"></textarea></div>
      <div class="field"><label>PDF attachment (optional)</label><input id="learningPdf" type="file" accept="application/pdf,.pdf" onchange="readLearningPdf(this)"><div class="hint" id="learningFileHint">Choose either written content, a PDF, or both.</div></div>
      <button class="btn btn-primary" onclick="saveLearningResource('${category}',this)">${isPrep?'Publish Guide':'Publish Material'}</button>
    </div>`:'';
  const empty=`<div class="empty" style="grid-column:1/-1;"><div class="e-icon">${isPrep?'✍️':'📚'}</div><div class="e-title">No ${isPrep?'exam prep guides':'study materials'} yet</div><div class="e-sub">${teacher?'Use the form above to share the first one.':'Your teachers have not shared anything here yet.'}</div></div>`;
  c.innerHTML=`<div class="page-header"><h2>${title}</h2><p>${intro}</p></div><div class="page-toolbar"><div class="search-box"><span>🔎</span><input value="${esc(window._learningSearches[category]||'')}" placeholder="Search title, subject or description" oninput="window._learningSearches['${category}']=this.value;renderLearningResources(document.getElementById('content'),'${category}')"></div><label style="font-size:.78rem;font-weight:600;color:var(--ink3);">Filter by class</label><select onchange="window._learningClassFilters['${category}']=this.value;renderLearningResources(document.getElementById('content'),'${category}')" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">${classFilterOptions(classFilter)}</select></div>${composer}
    <div id="learningList" class="material-grid">${items.length?items.map(learningCardHTML).join(''):empty}</div>`;
}

function learningCardHTML(item){
  const author=userById(item.createdBy);
  const canManage=currentUser().role==='admin' || currentProfile.id===item.createdBy;
  const commentCount=DB.materialComments.filter(c=>c.materialId===item.id).length;
  const kind=item.fileData?'PDF':'Text document';
  return `<article class="material-card"><div style="display:flex;justify-content:space-between;gap:10px;"><div class="material-icon">${item.fileData?'📄':'📝'}</div><span class="badge ${item.category==='exam-prep'?'b-series':'b-dpp'}">${kind}</span></div>
    <div><h3>${esc(item.title)}</h3><div class="ic-meta"><span>${esc(item.subject||'General')}</span><span>🏷️ ${item.cls==='ALL'||!item.cls?'All Classes':esc(className(item.cls))}</span><span>${esc(author?author.name:'Teacher')}</span></div></div>
    ${item.description?`<p>${esc(item.description)}</p>`:''}
    <div class="ic-actions" style="margin-top:auto;">${item.text?`<button class="btn btn-ghost btn-xs" onclick="openLearningText('${item.id}')">Read</button>`:''}${item.fileData?`<a class="btn btn-primary btn-xs" href="${item.fileData}" download="${esc(item.fileName||'study-material.pdf')}">Download PDF</a>`:''}<button class="btn btn-teal btn-xs" onclick="openMaterialDiscussion('${item.id}')">Questions (${commentCount})</button>${canManage?`<button class="btn btn-blue btn-xs" onclick="openEditLearningResource('${item.id}')">Edit</button><button class="btn btn-danger btn-xs" onclick="deleteLearningResource('${item.id}')">Delete</button>`:''}</div></article>`;
}

function readLearningPdf(input){
  const file=input.files&&input.files[0]; learningUploadData='';
  const hint=document.getElementById('learningFileHint');
  if(!file){if(hint)hint.textContent='Choose either written content, a PDF, or both.';return;}
  if(file.type!=='application/pdf' || file.size>500*1024){
    input.value=''; if(hint)hint.textContent='Please choose a PDF no larger than 500 KB.'; toast('PDF must be 500 KB or smaller','error'); return;
  }
  const reader=new FileReader();
  reader.onload=()=>{learningUploadData=reader.result; if(hint)hint.textContent='Attached: '+file.name+' ('+Math.ceil(file.size/1024)+' KB)';};
  reader.onerror=()=>toast('Could not read this PDF','error'); reader.readAsDataURL(file);
}

async function saveLearningResource(category,btn){
  const title=(document.getElementById('learningTitle').value||'').trim();
  const subject=(document.getElementById('learningSubject').value||'').trim();
  const cls=document.getElementById('learningClass').value;
  const description=(document.getElementById('learningDescription').value||'').trim();
  const text=(document.getElementById('learningText').value||'').trim();
  const file=document.getElementById('learningPdf').files[0];
  if(!title){toast('Please enter a title','error');return;}
  if(!text&&!learningUploadData){toast('Write a document or attach a PDF','error');return;}
  btn.disabled=true; btn.textContent='Publishing…';
  try{
    await dbFS.collection('studyMaterials').add({category,title,subject,cls,description,text,fileData:learningUploadData||'',fileName:file?file.name:'',createdBy:currentProfile.id,createdAt:nowISO()});
    learningUploadData=''; toast('Published for students','success'); render();
  }catch(e){toast('Could not publish: '+friendlyError(e),'error');btn.disabled=false;btn.textContent=category==='exam-prep'?'Publish Guide':'Publish Material';}
}

function openLearningText(id){
  const item=DB.studyMaterials.find(x=>x.id===id); if(!item)return;
  const html=`<div class="overlay" id="learningTextOverlay"><div class="modal modal-wide"><h3>${esc(item.title)}</h3><p class="modal-sub">${esc(item.subject||'General')} · ${esc(userById(item.createdBy)?.name||'Teacher')}</p><div style="white-space:pre-wrap;line-height:1.65;font-size:.86rem;padding:4px 0;">${esc(item.text||'')}</div><div class="modal-btns"><button class="btn btn-ghost" onclick="document.getElementById('learningTextOverlay').remove()">Close</button></div></div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
}

function openEditLearningResource(id){
  const item=DB.studyMaterials.find(x=>x.id===id); if(!item)return;
  learningEditUploadData='';
  const fileInfo=item.fileData?`Current PDF: ${esc(item.fileName||'attached PDF')}`:'No PDF attached.';
  const html=`<div class="overlay" id="editLearningOverlay" style="z-index:600;"><div class="modal modal-wide">
    <h3>Edit ${item.category==='exam-prep'?'Exam Prep Guide':'Study Material'}</h3>
    <p class="modal-sub">Update the content students see. Your changes are published immediately.</p>
    <div class="g2"><div class="field"><label>Title <span class="req">*</span></label><input id="editLearningTitle" maxlength="120" value="${esc(item.title)}"></div><div class="field"><label>Subject</label><input id="editLearningSubject" maxlength="100" value="${esc(item.subject||'')}"></div></div>
    <div class="field"><label>Target class <span class="req">*</span></label><select id="editLearningClass">${classFilterOptions(item.cls||'ALL')}</select></div>
    <div class="field"><label>Short description</label><input id="editLearningDescription" maxlength="300" value="${esc(item.description||'')}"></div>
    <div class="field"><label>Written document</label><textarea id="editLearningText" maxlength="40000">${esc(item.text||'')}</textarea></div>
    <div class="field"><label>Replace PDF attachment (optional)</label><input id="editLearningPdf" type="file" accept="application/pdf,.pdf" onchange="readEditLearningPdf(this)"><div class="hint" id="editLearningFileHint">${fileInfo}</div>${item.fileData?'<label style="margin-top:8px;text-transform:none;font-weight:500;"><input id="removeLearningPdf" type="checkbox" style="width:auto;margin-right:6px;"> Remove current PDF</label>':''}</div>
    <div class="modal-btns"><button class="btn btn-ghost" onclick="document.getElementById('editLearningOverlay').remove()">Cancel</button><button class="btn btn-primary" onclick="saveEditedLearningResource('${id}',this)">Save Changes</button></div>
  </div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
}

function readEditLearningPdf(input){
  const file=input.files&&input.files[0]; learningEditUploadData='';
  const hint=document.getElementById('editLearningFileHint');
  if(!file){if(hint)hint.textContent='No replacement PDF selected.';return;}
  if(file.type!=='application/pdf' || file.size>500*1024){input.value='';if(hint)hint.textContent='Please choose a PDF no larger than 500 KB.';toast('PDF must be 500 KB or smaller','error');return;}
  const reader=new FileReader();
  reader.onload=()=>{learningEditUploadData=reader.result;if(hint)hint.textContent='New PDF ready: '+file.name+' ('+Math.ceil(file.size/1024)+' KB)';};
  reader.onerror=()=>toast('Could not read this PDF','error');reader.readAsDataURL(file);
}

async function saveEditedLearningResource(id,btn){
  const item=DB.studyMaterials.find(x=>x.id===id); if(!item)return;
  const title=(document.getElementById('editLearningTitle').value||'').trim();
  const subject=(document.getElementById('editLearningSubject').value||'').trim();
  const cls=document.getElementById('editLearningClass').value;
  const description=(document.getElementById('editLearningDescription').value||'').trim();
  const text=(document.getElementById('editLearningText').value||'').trim();
  const replacement=document.getElementById('editLearningPdf').files[0];
  const remove=!!document.getElementById('removeLearningPdf')?.checked;
  const fileData=learningEditUploadData||(!remove?(item.fileData||''):'');
  const fileName=learningEditUploadData?(replacement?replacement.name:''):(!remove?(item.fileName||''):'');
  if(!title){toast('Please enter a title','error');return;}
  if(!text&&!fileData){toast('Keep written content or a PDF attachment','error');return;}
  btn.disabled=true;btn.textContent='Saving…';
  try{
    await dbFS.collection('studyMaterials').doc(id).update({title,subject,cls,description,text,fileData,fileName,updatedAt:nowISO()});
    learningEditUploadData='';document.getElementById('editLearningOverlay').remove();toast('Changes saved','success');
  }catch(e){toast('Could not save: '+friendlyError(e),'error');btn.disabled=false;btn.textContent='Save Changes';}
}

function openMaterialDiscussion(materialId){
  const item=DB.studyMaterials.find(x=>x.id===materialId); if(!item)return;
  const comments=DB.materialComments.filter(c=>c.materialId===materialId).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  const html=`<div class="overlay" id="materialDiscussionOverlay" data-material-id="${materialId}" style="z-index:600;"><div class="modal modal-wide"><h3>Questions & Discussion</h3><p class="modal-sub">${esc(item.title)}</p><div id="materialDiscussionList" style="max-height:300px;overflow-y:auto;margin-bottom:14px;">${materialDiscussionListHTML(comments)}</div><div class="field"><label>Ask a question or reply</label><textarea id="materialCommentText" maxlength="2000" placeholder="Write your question or answer…" style="min-height:70px;"></textarea></div><div class="modal-btns"><button class="btn btn-ghost" onclick="document.getElementById('materialDiscussionOverlay').remove()">Close</button><button class="btn btn-primary" onclick="postMaterialComment('${materialId}',this)">Post</button></div></div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
}
function materialDiscussionListHTML(comments){
  return comments.length?comments.map(c=>`<div style="padding:10px 0;border-bottom:1px solid var(--border);"><strong style="font-size:.8rem;">${esc(userById(c.userId)?.name||'User')}</strong><span style="font-size:.68rem;color:var(--ink4);margin-left:7px;">${fmtDate(c.createdAt)}</span><div style="white-space:pre-wrap;font-size:.82rem;line-height:1.5;margin-top:4px;">${esc(c.text)}</div></div>`).join(''):'<div class="empty" style="padding:20px;"><div class="e-sub">No questions yet. Start the discussion.</div></div>';
}
function refreshMaterialDiscussion(materialId){
  const overlay=document.getElementById('materialDiscussionOverlay');
  const list=document.getElementById('materialDiscussionList');
  if(!overlay||!list||overlay.dataset.materialId!==materialId)return;
  const comments=DB.materialComments.filter(c=>c.materialId===materialId).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  list.innerHTML=materialDiscussionListHTML(comments);
}
async function postMaterialComment(materialId,btn){
  const text=(document.getElementById('materialCommentText').value||'').trim();
  if(!text){toast('Write a question or reply first','error');return;}
  btn.disabled=true;
  try{await dbFS.collection('studyMaterials').doc(materialId).collection('comments').add({materialId,userId:currentProfile.id,text,createdAt:nowISO()});document.getElementById('materialDiscussionOverlay').remove();toast('Posted','success');}
  catch(e){toast('Could not post: '+friendlyError(e),'error');btn.disabled=false;}
}

function deleteLearningResource(id){
  openConfirm('Delete this resource?','Students will no longer be able to access it.',async()=>{try{await dbFS.collection('studyMaterials').doc(id).delete();toast('Resource deleted','success');}catch(e){toast('Could not delete: '+friendlyError(e),'error');}},'Delete');
}

/* ============ ADMIN: DASHBOARD ============ */
/* ============ CLASS POLLS ============ */
function pollOptionFieldHTML(index){
  return `<div class="field" data-poll-option-row><label>Option ${index}${index>2?' (optional)':''}</label><div style="display:flex;gap:6px;"><input data-poll-option maxlength="100" placeholder="Option ${index}">${index>2?`<button type="button" class="btn btn-ghost btn-xs" onclick="this.closest('[data-poll-option-row]').remove()">Remove</button>`:''}</div></div>`;
}
function renderPolls(c){
  ensurePollListeners();
  const u=currentUser();
  if(!window._pollClassFilter)window._pollClassFilter='ALL';
  const polls=DB.polls.filter(p=>matchesClass(p,window._pollClassFilter)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const composer=(u.role==='teacher'||u.role==='admin')?`<div class="card" style="margin-bottom:18px;"><div class="card-header"><h3>Create a quick class poll</h3></div><div class="field"><label>Question <span class="req">*</span></label><input id="pollQuestion" maxlength="220" placeholder="e.g. Which chapter should we revise next?"></div><div class="g2" id="pollOptions">${pollOptionFieldHTML(1)}${pollOptionFieldHTML(2)}${pollOptionFieldHTML(3)}</div><button type="button" class="btn btn-ghost btn-sm" onclick="addPollOption()">+ Add option</button><div class="field" style="margin-top:12px;"><label>Target class</label><select id="pollClass">${classFilterOptions('ALL')}</select></div><button class="btn btn-primary" onclick="createPoll(this)">Publish Poll</button></div>`:'';
  c.innerHTML=`<div class="page-header"><h2>Class Polls</h2><p>Quick questions and feedback for your classroom.</p></div><div class="page-toolbar"><label style="font-size:.78rem;font-weight:600;color:var(--ink3);">Filter by class</label><select onchange="window._pollClassFilter=this.value;renderPolls(document.getElementById('content'))" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">${classFilterOptions(window._pollClassFilter)}</select></div>${composer}<div class="material-grid">${polls.length?polls.map(pollCardHTML).join(''):'<div class="empty" style="grid-column:1/-1;"><div class="e-icon">🗳️</div><div class="e-title">No polls yet</div><div class="e-sub">Teachers can create the first class poll here.</div></div>'}</div>`;
}
function pollCardHTML(poll){
  const votes=DB.pollVotes.filter(v=>v.pollId===poll.id);const mine=votes.find(v=>v.userId===currentProfile.id);const total=votes.length;const canManage=currentUser().role==='admin'||poll.createdBy===currentProfile.id;
  const options=(poll.options||[]).map((option,i)=>{const count=votes.filter(v=>v.optionIndex===i).length;const pct=total?Math.round(count/total*100):0;return `<div style="margin:9px 0;"><button class="btn btn-ghost btn-sm" style="width:100%;justify-content:space-between;${mine||poll.closed?'cursor:default':''}" ${mine||poll.closed?'disabled':''} onclick="voteOnPoll('${poll.id}',${i},this)"><span>${esc(option)}</span><span>${mine?count+' ('+pct+'%)':'Vote'}</span></button>${mine?`<div class="progress-track" style="margin-top:4px;"><div class="progress-fill" style="width:${pct}%;"></div></div>`:''}</div>`;}).join('');
  return `<article class="material-card"><div style="display:flex;justify-content:space-between;gap:8px;"><div class="material-icon">🗳️</div><span class="badge ${poll.closed?'b-draft':'b-live'}">${poll.closed?'Closed':'Open'}</span></div><div><h3>${esc(poll.question)}</h3><div class="ic-meta"><span>🏷️ ${poll.cls==='ALL'||!poll.cls?'All Classes':esc(className(poll.cls))}</span><span>${total} vote${total===1?'':'s'}</span></div></div><div>${options}</div>${canManage?`<div class="ic-actions" style="margin-top:auto;">${!poll.closed?`<button class="btn btn-gold btn-xs" onclick="closePoll('${poll.id}')">Close Poll</button>`:''}<button class="btn btn-danger btn-xs" onclick="deletePoll('${poll.id}')">Delete</button></div>`:''}</article>`;
}
function addPollOption(){
  const wrap=document.getElementById('pollOptions'); const count=wrap.querySelectorAll('[data-poll-option]').length;
  if(count>=10){toast('A poll can have up to 10 options','warn');return;}
  wrap.insertAdjacentHTML('beforeend',pollOptionFieldHTML(count+1));
}
async function createPoll(btn){
  const question=(document.getElementById('pollQuestion').value||'').trim();const options=[...document.querySelectorAll('[data-poll-option]')].map(el=>el.value.trim()).filter(Boolean);const cls=document.getElementById('pollClass').value;
  if(!question||options.length<2){toast('Add a question and at least two options','error');return;}btn.disabled=true;
  try{await dbFS.collection('polls').add({question,options,cls,createdBy:currentProfile.id,createdAt:nowISO(),closed:false});toast('Poll published','success');}catch(e){toast('Could not publish: '+friendlyError(e),'error');btn.disabled=false;}
}
async function voteOnPoll(pollId,optionIndex,btn){
  btn.disabled=true;try{await dbFS.collection('polls').doc(pollId).collection('votes').doc(currentProfile.id).set({pollId,userId:currentProfile.id,optionIndex,createdAt:nowISO()});toast('Vote recorded','success');}catch(e){toast('Could not vote: '+friendlyError(e),'error');btn.disabled=false;}
}
async function closePoll(id){try{await dbFS.collection('polls').doc(id).update({closed:true,closedAt:nowISO()});toast('Poll closed','success');}catch(e){toast('Could not close poll: '+friendlyError(e),'error');}}
function deletePoll(id){openConfirm('Delete this poll?','Votes for it will no longer be shown.',async()=>{try{await dbFS.collection('polls').doc(id).delete();toast('Poll deleted','success');}catch(e){toast('Could not delete poll: '+friendlyError(e),'error');}},'Delete');}

function renderAdminDashboard(c){
  const totalUsers=DB.users.filter(u=>u.role!=='admin').length;
  const pending=DB.users.filter(u=>u.status==='pending').length;
  const teachers=DB.users.filter(u=>u.role==='teacher'&&u.status==='approved').length;
  const students=DB.users.filter(u=>u.role==='student'&&u.status==='approved').length;
  const totalTests=DB.tests.length;
  const totalAttempts=DB.attempts.length;
  c.innerHTML=`
  <div class="page-header"><h2>Welcome back, Admin 👋</h2><p>Here's what's happening across PrepHub right now.</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('👥','Total Users',totalUsers,'var(--blue)','var(--blue-lt)')}
    ${statCard('⏳','Pending Approvals',pending,'var(--gold)','var(--gold-lt)')}
    ${statCard('🧑‍🏫','Active Teachers',teachers,'var(--purple)','var(--purple-lt)')}
    ${statCard('🎓','Active Students',students,'var(--teal)','var(--teal-lt)')}
  </div>
  <div class="g2">
    <div class="card">
      <div class="card-header"><h3>Test Activity</h3></div>
      <div class="g2">
        ${miniStat('Total Tests / DPPs',totalTests)}
        ${miniStat('Total Attempts',totalAttempts)}
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h3>Recent Registrations</h3></div>
      ${recentUsersList()}
    </div>
  </div>`;
}
function statCard(icon,label,num,color,bg){
  return '<div class="stat-card"><div class="sc-top"><div class="sc-icon" style="background:'+bg+';color:'+color+'">'+icon+'</div></div><div class="sc-num">'+num+'</div><div class="sc-label">'+label+'</div><div class="sc-bar" style="background:'+color+'"></div></div>';
}
function miniStat(label,num){
  return '<div style="text-align:center;padding:14px;background:var(--bg);border-radius:10px;"><div style="font-family:\'Crimson Pro\',serif;font-size:1.8rem;font-weight:700;">'+num+'</div><div style="font-size:.75rem;color:var(--ink3);margin-top:4px;">'+label+'</div></div>';
}
function recentUsersList(){
  const recent=[...DB.users].filter(u=>u.role!=='admin').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5);
  if(!recent.length) return '<div class="empty"><div class="e-icon">📭</div><div class="e-title">No registrations yet</div></div>';
  return recent.map(u=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);">
    <div><strong style="font-size:.85rem;">${esc(u.name)}</strong><div style="font-size:.72rem;color:var(--ink4);">${esc(u.email)} · ${u.role}</div></div>
    <span class="badge b-${u.status}">${u.status}</span></div>`).join('');
}

/* ============ ADMIN: APPROVALS ============ */
function renderApprovals(c){
  const pending=DB.users.filter(u=>u.status==='pending');
  c.innerHTML=`<div class="page-header"><h2>Pending Approvals</h2><p>Review and approve new teacher &amp; student registrations.</p></div>
  <div id="pendingList"></div>`;
  const list=document.getElementById('pendingList');
  if(!pending.length){list.innerHTML='<div class="empty"><div class="e-icon">🎉</div><div class="e-title">All caught up</div><div class="e-sub">No pending registrations right now.</div></div>';return;}
  list.innerHTML=pending.map(u=>`
    <div class="item-card">
      <div class="ic-top">
        <div><div class="ic-title">${esc(u.name)} <span class="badge b-${u.role==='teacher'?'teacher':'student'}">${u.role}</span></div>
        <div class="ic-meta">
          <span>✉️ ${esc(u.email)}</span>
          <span>🏫 ${esc(schoolName(u.school))}</span>
          <span>🏷️ ${esc(className(u.cls))}</span>
          ${u.phone?'<span>📞 '+esc(u.phone)+'</span>':''}
          ${u.subject?'<span>📖 '+esc(u.subject)+'</span>':''}
          <span>🕒 ${fmtDate(u.createdAt)}</span>
        </div></div>
      </div>
      <div class="ic-actions">
        <button class="btn btn-success btn-sm" onclick="approveUser('${u.id}')">✅ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="rejectUser('${u.id}')">✖ Reject</button>
      </div>
    </div>`).join('');
}
async function approveUser(id){
  const u=userById(id); if(!u) return;
  try{
    const batch=dbFS.batch();
    batch.update(dbFS.collection('users').doc(id),{status:'approved'});
    batch.set(dbFS.collection('userDirectory').doc(id),{name:u.name,role:u.role,school:u.school||'',cls:u.cls||'',status:'approved'},{merge:true});
    await batch.commit();
    localUpdate('users',id,{status:'approved'});
    toast(u.name+' approved','success'); refreshUI();
  }catch(e){ toast('Failed to approve: '+friendlyError(e),'error'); }
}
function rejectUser(id){
  const u=userById(id); if(!u) return;
  openConfirm('Reject this user?','This will mark the registration as rejected.',async()=>{
    try{
      const batch=dbFS.batch();
      batch.update(dbFS.collection('users').doc(id),{status:'rejected'});
      batch.set(dbFS.collection('userDirectory').doc(id),{status:'rejected'},{merge:true});
      await batch.commit();
      localUpdate('users',id,{status:'rejected'});
      toast(u.name+' rejected','warn'); refreshUI();
    }catch(e){ toast('Failed to reject: '+friendlyError(e),'error'); }
  },'Reject');
}

/* ============ ADMIN: MANAGE USERS ============ */
function renderUsers(c){
  const users=DB.users.filter(u=>u.role!=='admin');
  c.innerHTML=`<div class="page-header"><h2>Manage Users</h2><p>All teachers and students in the system.</p></div>
  <div class="page-toolbar">
    <div class="search-box">🔍<input type="text" id="userSearch" placeholder="Search by name or email..." oninput="renderUsersTable()"></div>
    <button class="filter-btn active" data-f="all" onclick="setUserFilter('all')">All</button>
    <button class="filter-btn" data-f="teacher" onclick="setUserFilter('teacher')">Teachers</button>
    <button class="filter-btn" data-f="student" onclick="setUserFilter('student')">Students</button>
  </div>
  <div class="card"><div id="usersTableWrap"></div></div>`;
  window._userFilter='all';
  renderUsersTable();
}
function setUserFilter(f){
  window._userFilter=f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.f===f));
  renderUsersTable();
}
function renderUsersTable(){
  const q=(document.getElementById('userSearch')?.value||'').toLowerCase();
  const f=window._userFilter||'all';
  let users=DB.users.filter(u=>u.role!=='admin');
  if(f!=='all') users=users.filter(u=>u.role===f);
  if(q) users=users.filter(u=>u.name.toLowerCase().includes(q)||u.email.toLowerCase().includes(q));
  const wrap=document.getElementById('usersTableWrap');
  if(!users.length){wrap.innerHTML='<div class="empty"><div class="e-icon">🔍</div><div class="e-title">No users found</div></div>';return;}
  wrap.innerHTML=`<table class="datatable"><thead><tr><th>Name</th><th>Role</th><th>School / Class</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>
  ${users.map(u=>`<tr>
    <td><strong>${esc(u.name)}</strong><br><span style="color:var(--ink4);font-size:.75rem;">${esc(u.email)}</span></td>
    <td><span class="badge b-${u.role}">${u.role}</span></td>
    <td>${esc(schoolName(u.school))}<br><span style="color:var(--ink4);font-size:.75rem;">${esc(className(u.cls))}</span></td>
    <td><span class="badge b-${u.status}">${u.status}</span></td>
    <td>${fmtDate(u.createdAt)}</td>
    <td>
      ${u.status==='approved'?'<button class="btn btn-gold btn-xs" onclick="suspendUser(\''+u.id+'\')">Suspend</button>':'<button class="btn btn-success btn-xs" onclick="approveUser(\''+u.id+'\')">Approve</button>'}
      <button class="btn btn-danger btn-xs" onclick="deleteUser('${u.id}')">Delete</button>
    </td>
  </tr>`).join('')}
  </tbody></table>`;
}
async function suspendUser(id){
  try{
    const batch=dbFS.batch();
    batch.update(dbFS.collection('users').doc(id),{status:'rejected'});
    batch.set(dbFS.collection('userDirectory').doc(id),{status:'rejected'},{merge:true});
    await batch.commit();
    localUpdate('users',id,{status:'rejected'});
    toast('User suspended','warn'); refreshUI();
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
function deleteUser(id){
  openConfirm('Delete this user?','This permanently removes their profile and submissions and cannot be undone. Note: their login (Firebase Auth) account itself must be removed separately from the Firebase console — deleting an auth account requires admin-level server access this app does not have.',async()=>{
    try{
      const batch=dbFS.batch();
      batch.delete(dbFS.collection('users').doc(id));
      batch.delete(dbFS.collection('userDirectory').doc(id));
      const attSnap=await dbFS.collection('attempts').where('userId','==',id).get();
      attSnap.forEach(d=>batch.delete(d.ref));
      await batch.commit();
      localRemove('users',id);
      DB.attempts=DB.attempts.filter(a=>a.userId!==id);
      toast('User deleted','success'); refreshUI();
    }catch(e){ toast('Failed to delete: '+friendlyError(e),'error'); }
  },'Delete');
}

/* ============ ADMIN: SCHOOLS & CLASSES (registration setup) ============ */
function renderRegistry(c){
  c.innerHTML=`<div class="page-header"><h2>Schools &amp; Classes</h2><p>Manage the school and class list used during registration and test targeting.</p></div>
  <div class="g2">
    <div class="card">
      <div class="card-header"><h3>🏫 Schools</h3></div>
      <div style="display:flex;gap:8px;margin-bottom:14px;">
        <input type="text" id="newSchoolName" placeholder="New school name" style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);">
        <button class="btn btn-primary" onclick="addSchool()">Add</button>
      </div>
      <div id="schoolList"></div>
    </div>
    <div class="card">
      <div class="card-header"><h3>🏷️ Classes</h3></div>
      <div style="display:flex;gap:8px;margin-bottom:14px;">
        <input type="text" id="newClassName" placeholder="New class name (e.g. Class 10, JEE Batch A)" style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);">
        <button class="btn btn-primary" onclick="addClass()">Add</button>
      </div>
      <div id="classList"></div>
    </div>
  </div>`;
  renderSchoolList(); renderClassList();
}
function renderSchoolList(){
  const el=document.getElementById('schoolList');
  if(!DB.schools.length){el.innerHTML='<div class="empty"><div class="e-icon">🏫</div><div class="e-title">No schools added</div></div>';return;}
  el.innerHTML=DB.schools.map(s=>{
    const inUse=DB.users.some(u=>u.school===s.id);
    return '<div class="tag-chip">🏫 '+esc(s.name)+' <button onclick="removeSchool(\''+s.id+'\','+inUse+')">✕</button></div>';
  }).join('');
}
function renderClassList(){
  const el=document.getElementById('classList');
  if(!DB.classes.length){el.innerHTML='<div class="empty"><div class="e-icon">🏷️</div><div class="e-title">No classes added</div></div>';return;}
  el.innerHTML=DB.classes.map(cl=>{
    const inUse=DB.users.some(u=>u.cls===cl.id);
    return '<div class="tag-chip">🏷️ '+esc(cl.name)+' <button onclick="removeClass(\''+cl.id+'\','+inUse+')">✕</button></div>';
  }).join('');
}
async function addSchool(){
  const inp=document.getElementById('newSchoolName'); const name=inp.value.trim();
  if(!name){toast('Enter a school name','error');return;}
  try{
    const id=uid('sch');
    await dbFS.collection('schools').doc(id).set({name});
    localUpsert('schools',id,{name});
    inp.value=''; renderSchoolList(); toast('School added','success');
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
function removeSchool(id,inUse){
  const doIt=async()=>{
    try{
      await dbFS.collection('schools').doc(id).delete();
      localRemove('schools',id);
      renderSchoolList(); toast('School removed','success');
    }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
  };
  if(inUse){openConfirm('School is in use','Some users are linked to this school. Remove anyway?',doIt,'Remove');}else{doIt();}
}
async function addClass(){
  const inp=document.getElementById('newClassName'); const name=inp.value.trim();
  if(!name){toast('Enter a class name','error');return;}
  try{
    const id=uid('cls');
    await dbFS.collection('classes').doc(id).set({name});
    localUpsert('classes',id,{name});
    inp.value=''; renderClassList(); toast('Class added','success');
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
function removeClass(id,inUse){
  const doIt=async()=>{
    try{
      await dbFS.collection('classes').doc(id).delete();
      localRemove('classes',id);
      renderClassList(); toast('Class removed','success');
    }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
  };
  if(inUse){openConfirm('Class is in use','Some users are linked to this class. Remove anyway?',doIt,'Remove');}else{doIt();}
}

/* ============ ADMIN: ALL TESTS ============ */
function renderAllTests(c){
  if(!window._allTestsClassFilter) window._allTestsClassFilter='ALL';
  if(window._allTestsSearch===undefined)window._allTestsSearch='';
  c.innerHTML=`<div class="page-header"><h2>All Tests &amp; DPPs</h2><p>Every test created across PrepHub.</p></div><div class="page-toolbar"><div class="search-box"><span>🔎</span><input value="${esc(window._allTestsSearch)}" placeholder="Search tests or subjects" oninput="window._allTestsSearch=this.value;renderAllTests(document.getElementById('content'))"></div><label style="font-size:.78rem;font-weight:600;color:var(--ink3);">Filter by class</label><select onchange="window._allTestsClassFilter=this.value;renderAllTests(document.getElementById('content'))" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">${classFilterOptions(window._allTestsClassFilter)}</select></div><div id="allTestsList"></div>`;
  const wrap=document.getElementById('allTestsList');
  const tests=DB.tests.filter(t=>matchesClass(t,window._allTestsClassFilter)&&matchesSearch(t,window._allTestsSearch));
  if(!tests.length){wrap.innerHTML='<div class="empty"><div class="e-icon">📝</div><div class="e-title">No tests for this class</div></div>';return;}
  wrap.innerHTML=[...tests].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(t=>testCardHTML(t,true)).join('');
}

/* ============ TEACHER: DASHBOARD ============ */
function renderTeacherDashboard(c){
  const u=currentUser();
  const myTests=DB.tests.filter(t=>t.createdBy===u.id);
  const myAttempts=DB.attempts.filter(a=>myTests.some(t=>t.id===a.testId));
  const published=myTests.filter(t=>t.published).length;
  c.innerHTML=`
  <div class="page-header"><h2>Welcome, ${esc(u.name)} 👋</h2><p>${esc(u.subject||'Teacher')} · manage your DPPs and test series.</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('📝','My Tests / DPPs',myTests.length,'var(--blue)','var(--blue-lt)')}
    ${statCard('🟢','Published',published,'var(--green)','var(--green-lt)')}
    ${statCard('🧾','Total Submissions',myAttempts.length,'var(--purple)','var(--purple-lt)')}
    ${statCard('📊','Avg Score %',avgScorePct(myAttempts,myTests)+'%','var(--teal)','var(--teal-lt)')}
  </div>
  <div class="card">
    <div class="card-header"><h3>Recent Tests</h3><button class="btn btn-primary btn-sm" onclick="goPage('createtest')">➕ New Test</button></div>
    ${myTests.length? [...myTests].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5).map(t=>testCardHTML(t,false)).join('') : '<div class="empty"><div class="e-icon">📝</div><div class="e-title">No tests yet</div><div class="e-sub">Click "New Test" to create your first DPP or test series.</div></div>'}
  </div>`;
}
function avgScorePct(attempts,tests){
  if(!attempts.length) return 0;
  let total=0,cnt=0;
  attempts.forEach(a=>{const t=tests.find(x=>x.id===a.testId)||testById(a.testId); if(!t)return; const mx=maxScoreOf(t); if(mx>0){total+=(a.score/mx*100);cnt++;}});
  return cnt? Math.round(total/cnt):0;
}

/* ============ TEST CARD (shared) ============ */
function testCardHTML(t,showCreator){
  const creator=userById(t.createdBy);
  const attempts=testAttempts(t.id);
  const u=currentUser();
  const canManage = u.role==='admin' || (u.role==='teacher' && t.createdBy===u.id);
  return `<div class="item-card">
    <div class="ic-top">
      <div>
        <div class="ic-title">${esc(t.title)} <span class="badge b-${t.type==='DPP'?'dpp':'series'}">${t.type}</span> <span class="badge b-${t.published?'live':'draft'}">${t.published?'Published':'Draft'}</span></div>
        <div class="ic-meta">
          <span>📖 ${esc(t.subject||'General')}</span>
          <span>❓ ${t.questions.length} Qs</span>
          <span>🏫 ${t.school==='ALL'?'All Schools':esc(schoolName(t.school))}</span>
          <span>🏷️ ${t.cls==='ALL'?'All Classes':esc(className(t.cls))}</span>
          <span>⏱ ${t.duration>0?t.duration+' min':'No limit'}</span>
          ${showCreator?'<span>🧑‍🏫 '+esc(creator?creator.name:'Unknown')+'</span>':''}
          <span>🧾 ${attempts.length} submissions</span>
          <span>🕒 ${fmtDate(t.createdAt)}</span>
        </div>
      </div>
    </div>
    <div class="ic-actions">
      <button class="btn btn-teal btn-sm" onclick="goPage('testanalytics',{testId:'${t.id}'})">📈 Analytics</button>
      ${canManage?'<button class="btn btn-blue btn-sm" onclick="editTest(\''+t.id+'\')">✏️ Edit</button>':''}
      ${canManage?'<button class="btn '+(t.published?'btn-gold':'btn-success')+' btn-sm" onclick="togglePublish(\''+t.id+'\')">'+(t.published?'⏸ Unpublish':'▶ Publish')+'</button>':''}
      ${canManage?'<button class="btn btn-danger btn-sm" onclick="deleteTest(\''+t.id+'\')">🗑 Delete</button>':''}
    </div>
  </div>`;
}
async function togglePublish(id){
  const t=testById(id); if(!t) return;
  try{
    await dbFS.collection('tests').doc(id).update({published:!t.published});
    localUpdate('tests',id,{published:!t.published});
    toast(!t.published?'Test published':'Test unpublished','success'); render();
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
function deleteTest(id){
  openConfirm('Delete this test?','All submissions for this test will also be removed. This cannot be undone.',async()=>{
    try{
      const batch=dbFS.batch();
      batch.delete(dbFS.collection('tests').doc(id));
      const attSnap=await dbFS.collection('attempts').where('testId','==',id).get();
      attSnap.forEach(d=>batch.delete(d.ref));
      await batch.commit();
      localRemove('tests',id);
      DB.attempts=DB.attempts.filter(a=>a.testId!==id);
      toast('Test deleted','success'); render();
    }catch(e){ toast('Failed to delete: '+friendlyError(e),'error'); }
  },'Delete');
}
function editTest(id){goPage('edittest',{testId:id});}

/* ============ TEACHER: MY TESTS ============ */
function renderMyTests(c){
  const u=currentUser();
  if(!window._myTestsClassFilter) window._myTestsClassFilter='ALL';
  if(window._myTestsSearch===undefined)window._myTestsSearch='';
  const mine=DB.tests.filter(t=>t.createdBy===u.id && matchesClass(t,window._myTestsClassFilter)&&matchesSearch(t,window._myTestsSearch));
  c.innerHTML=`<div class="page-header"><h2>My Tests &amp; DPPs</h2><p>Everything you've created.</p></div>
  <div class="page-toolbar"><button class="btn btn-primary" onclick="goPage('createtest')">➕ Create New Test / DPP</button><div class="search-box"><span>🔎</span><input value="${esc(window._myTestsSearch)}" placeholder="Search tests or subjects" oninput="window._myTestsSearch=this.value;renderMyTests(document.getElementById('content'))"></div><label style="font-size:.78rem;font-weight:600;color:var(--ink3);">Filter by class</label><select onchange="window._myTestsClassFilter=this.value;renderMyTests(document.getElementById('content'))" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">${classFilterOptions(window._myTestsClassFilter)}</select></div>
  <div id="myTestsList"></div>`;
  const wrap=document.getElementById('myTestsList');
  wrap.innerHTML= mine.length? [...mine].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(t=>testCardHTML(t,false)).join('') : '<div class="empty"><div class="e-icon">📝</div><div class="e-title">No tests yet</div></div>';
}

/* ============ TEACHER: CREATE / EDIT TEST ============ */
let draftTest=null;
function renderCreateTest(c){
  const editingId=uiState.pageParams.testId;
  if(editingId){
    const existing=testById(editingId);
    draftTest=JSON.parse(JSON.stringify(existing));
  } else {
    // Always start a clean form for "Create Test / DPP" — this page is only
    // re-rendered on an actual navigation (background syncs skip it), so there's
    // no risk of wiping in-progress edits by resetting here.
    draftTest={id:uid('test'),title:'',type:'DPP',subject:'',school:'ALL',cls:'ALL',duration:0,publishAt:'',dueAt:'',questions:[],published:false,createdBy:currentUser().id,createdAt:nowISO()};
  }
  const schoolOpts=['<option value="ALL">All Schools</option>'].concat(DB.schools.map(s=>'<option value="'+s.id+'"'+(draftTest.school===s.id?' selected':'')+'>'+esc(s.name)+'</option>')).join('');
  const classOpts=['<option value="ALL">All Classes</option>'].concat(DB.classes.map(cl=>'<option value="'+cl.id+'"'+(draftTest.cls===cl.id?' selected':'')+'>'+esc(cl.name)+'</option>')).join('');
  c.innerHTML=`
  <div class="page-header"><h2>${editingId?'Edit':'Create'} Test / DPP</h2><p>Add single-choice, multiple-choice or integer-answer questions.</p></div>
  <div class="card" style="margin-bottom:16px;">
    <div class="g2">
      <div class="field"><label>Title <span class="req">*</span></label><input type="text" id="tTitle" value="${esc(draftTest.title)}" placeholder="e.g. Daily Practice — Trigonometry"></div>
      <div class="field"><label>Type</label><select id="tType">
        <option value="DPP" ${draftTest.type==='DPP'?'selected':''}>DPP (Daily Practice)</option>
        <option value="Test Series" ${draftTest.type==='Test Series'?'selected':''}>Test Series</option>
      </select></div>
    </div>
    <div class="g3">
      <div class="field"><label>Subject</label><input type="text" id="tSubject" value="${esc(draftTest.subject)}" placeholder="e.g. Physics"></div>
      <div class="field"><label>Target School</label><select id="tSchool">${schoolOpts}</select></div>
      <div class="field"><label>Target Class</label><select id="tClass">${classOpts}</select></div>
    </div>
    <div class="g3"><div class="field"><label>Duration (minutes, 0 = no limit)</label><input type="number" id="tDuration" min="0" value="${draftTest.duration||0}"></div><div class="field"><label>Schedule publish (optional)</label><input type="datetime-local" id="tPublishAt" value="${draftTest.publishAt?String(draftTest.publishAt).slice(0,16):''}"><div class="hint">Students cannot see it before this time.</div></div><div class="field"><label>Deadline (optional)</label><input type="datetime-local" id="tDueAt" value="${draftTest.dueAt?String(draftTest.dueAt).slice(0,16):''}"><div class="hint">Shown to students as a due date.</div></div></div>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="card-header"><h3>Questions (${draftTest.questions.length})</h3>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-blue btn-sm" onclick="addQuestion('single')">➕ Single Choice</button>
        <button class="btn btn-purple btn-sm" onclick="addQuestion('multiple')">➕ Multiple Choice</button>
        <button class="btn btn-teal btn-sm" onclick="addQuestion('integer')">➕ Integer</button>
      </div>
    </div>
    <div id="questionsWrap"></div>
  </div>

  <div style="display:flex;gap:10px;">
    <button class="btn btn-ghost" onclick="draftTest=null;goPage('mytests')">Cancel</button>
    <button class="btn btn-blue" onclick="saveTestDraft(false)">💾 Save as Draft</button>
    <button class="btn btn-primary" onclick="saveTestDraft(true)">🚀 Save &amp; Publish</button>
  </div>`;
  renderQuestionsWrap();
}
function renderQuestionsWrap(){
  const wrap=document.getElementById('questionsWrap');
  if(!draftTest.questions.length){wrap.innerHTML='<div class="empty"><div class="e-icon">❓</div><div class="e-title">No questions yet</div><div class="e-sub">Add a question using the buttons above.</div></div>';return;}
  wrap.innerHTML=draftTest.questions.map((q,i)=>questionEditorHTML(q,i)).join('');
}
function questionEditorHTML(q,i){
  let optsHTML='';
  if(q.type==='single'||q.type==='multiple'){
    optsHTML=q.options.map((o,oi)=>{
      const checked = q.type==='single' ? (q.correct===o.id) : (q.correct.includes(o.id));
      const inputType = q.type==='single'?'radio':'checkbox';
      return `<div class="opt-row">
        <input type="${inputType}" name="correct_${q.id}" ${checked?'checked':''} onclick="setCorrect('${q.id}','${o.id}','${q.type}')">
        <input type="text" value="${esc(o.text)}" placeholder="Option text" oninput="updateOptionText('${q.id}','${o.id}',this.value)">
        <button class="btn btn-danger btn-xs" onclick="removeOption('${q.id}','${o.id}')">✕</button>
      </div>`;
    }).join('');
    optsHTML+=`<button class="btn btn-ghost btn-xs" onclick="addOption('${q.id}')">➕ Add option</button>`;
  } else if(q.type==='integer'){
    optsHTML=`<div class="field" style="max-width:220px;"><label>Correct Integer Answer</label><input type="number" value="${q.correct!=null?q.correct:''}" oninput="setIntegerAnswer('${q.id}',this.value)"></div>`;
  }
  const typeLabel={single:'Single Choice',multiple:'Multiple Choice',integer:'Integer Answer'}[q.type];
  return `<div class="qcard">
    <div class="qcard-head">
      <span class="badge b-${q.type==='integer'?'series':(q.type==='single'?'teacher':'student')}">${typeLabel}</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <label style="font-size:.72rem;color:var(--ink3);">Marks</label>
        <input type="number" min="1" value="${q.marks}" style="width:60px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;" oninput="setMarks('${q.id}',this.value)">
        <button class="btn btn-danger btn-xs" onclick="removeQuestion('${q.id}')">🗑 Remove</button>
      </div>
    </div>
    <div class="field"><label>Question ${i+1}</label><textarea oninput="setQuestionText('${q.id}',this.value)" placeholder="Enter question text">${esc(q.text)}</textarea></div>
    ${optsHTML}
  </div>`;
}
function findQ(id){return draftTest.questions.find(q=>q.id===id);}
function addQuestion(type){
  const q={id:uid('q'),type,text:'',marks:1};
  if(type==='single'){q.options=[{id:uid('o'),text:''},{id:uid('o'),text:''}]; q.correct=null;}
  else if(type==='multiple'){q.options=[{id:uid('o'),text:''},{id:uid('o'),text:''}]; q.correct=[];}
  else {q.correct=null;}
  draftTest.questions.push(q);
  renderQuestionsWrap();
}
function removeQuestion(id){draftTest.questions=draftTest.questions.filter(q=>q.id!==id); renderQuestionsWrap();}
function setQuestionText(id,val){findQ(id).text=val;}
function setMarks(id,val){findQ(id).marks=Math.max(1,parseInt(val)||1);}
function addOption(id){const q=findQ(id); q.options.push({id:uid('o'),text:''}); renderQuestionsWrap();}
function removeOption(qid,oid){
  const q=findQ(qid); q.options=q.options.filter(o=>o.id!==oid);
  if(q.type==='single' && q.correct===oid) q.correct=null;
  if(q.type==='multiple') q.correct=q.correct.filter(x=>x!==oid);
  renderQuestionsWrap();
}
function updateOptionText(qid,oid,val){const q=findQ(qid); const o=q.options.find(x=>x.id===oid); o.text=val;}
function setCorrect(qid,oid,type){
  const q=findQ(qid);
  if(type==='single'){q.correct=oid;}
  else{ if(q.correct.includes(oid)) q.correct=q.correct.filter(x=>x!==oid); else q.correct.push(oid); }
}
function setIntegerAnswer(qid,val){findQ(qid).correct = val===''? null : Number(val);}

function saveTestDraft(publish){
  draftTest.title=document.getElementById('tTitle').value.trim();
  draftTest.type=document.getElementById('tType').value;
  draftTest.subject=document.getElementById('tSubject').value.trim();
  draftTest.school=document.getElementById('tSchool').value;
  draftTest.cls=document.getElementById('tClass').value;
  draftTest.duration=parseInt(document.getElementById('tDuration').value)||0;
  draftTest.publishAt=document.getElementById('tPublishAt').value||'';
  draftTest.dueAt=document.getElementById('tDueAt').value||'';
  if(!draftTest.title){toast('Please enter a title','error');return;}
  if(!draftTest.questions.length){toast('Add at least one question','error');return;}
  for(const q of draftTest.questions){
    if(!q.text.trim()){toast('Every question needs question text','error');return;}
    if(q.type==='single' && !q.correct){toast('Mark a correct option for every single-choice question','error');return;}
    if(q.type==='multiple' && !q.correct.length){toast('Mark at least one correct option for every multiple-choice question','error');return;}
    if(q.type==='integer' && (q.correct===null||q.correct===undefined||isNaN(q.correct))){toast('Enter a correct integer answer for every integer question','error');return;}
    if((q.type==='single'||q.type==='multiple') && q.options.some(o=>!o.text.trim())){toast('Fill in all option text fields','error');return;}
  }
  draftTest.published = publish;
  saveTestDraftToFirestore(publish);
}
async function saveTestDraftToFirestore(publish){
  const toSave={...draftTest};
  try{
    await dbFS.collection('tests').doc(toSave.id).set(toSave);
    localUpsert('tests',toSave.id,toSave);
    toast(publish?'Test published!':'Draft saved','success');
    draftTest=null;
    goPage('mytests');
  }catch(e){
    toast('Failed to save: '+friendlyError(e),'error');
  }
}

/* ============ STUDENT: DASHBOARD ============ */
function renderStudentDashboard(c){
  const u=currentUser();
  const avail=availableTestsFor(u).filter(t=>!hasAttempted(u.id,t.id));
  const myAtt=userAttempts(u.id);
  c.innerHTML=`
  <div class="page-header"><h2>Welcome, ${esc(u.name)} 👋</h2><p>${esc(schoolName(u.school))} · ${esc(className(u.cls))}</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('📥','Available Tests',avail.length,'var(--blue)','var(--blue-lt)')}
    ${statCard('🧾','Tests Attempted',myAtt.length,'var(--purple)','var(--purple-lt)')}
    ${statCard('📊','Avg Score %',avgScorePctForUser(u.id)+'%','var(--teal)','var(--teal-lt)')}
    ${statCard('🏆','Best Score %',bestScorePctForUser(u.id)+'%','var(--green)','var(--green-lt)')}
  </div>
  <div class="card">
    <div class="card-header"><h3>Tests Waiting For You</h3><button class="btn btn-primary btn-sm" onclick="goPage('available')">View All</button></div>
    ${avail.length? avail.slice(0,4).map(t=>studentTestCard(t)).join(''):'<div class="empty"><div class="e-icon">🎉</div><div class="e-title">All caught up!</div><div class="e-sub">No pending tests right now.</div></div>'}
  </div>`;
}
function isTestLive(t){return !!t.published && (!t.publishAt || new Date(t.publishAt)<=new Date());}
function availableTestsFor(u){
  return DB.tests.filter(t=> isTestLive(t) && (t.school==='ALL'||t.school===u.school) && (t.cls==='ALL'||t.cls===u.cls));
}
function hasAttempted(userId,testId){return DB.attempts.some(a=>a.userId===userId && a.testId===testId);}
function avgScorePctForUser(userId){
  const atts=userAttempts(userId); if(!atts.length)return 0;
  let total=0,cnt=0;
  atts.forEach(a=>{const t=testById(a.testId); if(!t)return; const mx=maxScoreOf(t); if(mx>0){total+=a.score/mx*100;cnt++;}});
  return cnt?Math.round(total/cnt):0;
}
function bestScorePctForUser(userId){
  const atts=userAttempts(userId); if(!atts.length)return 0;
  let best=0;
  atts.forEach(a=>{const t=testById(a.testId); if(!t)return; const mx=maxScoreOf(t); if(mx>0) best=Math.max(best,a.score/mx*100);});
  return Math.round(best);
}
function studentTestCard(t){
  const myAtts=DB.attempts.filter(a=>a.userId===currentUser().id && a.testId===t.id);
  const done=myAtts.length>0;
  return `<div class="item-card">
    <div class="ic-top">
      <div>
        <div class="ic-title">${esc(t.title)} <span class="badge b-${t.type==='DPP'?'dpp':'series'}">${t.type}</span>${done?' <span class="badge b-approved">'+myAtts.length+' attempt'+(myAtts.length>1?'s':'')+'</span>':''}</div>
        <div class="ic-meta">
          <span>📖 ${esc(t.subject||'General')}</span>
          <span>❓ ${t.questions.length} Qs</span>
          <span>⏱ ${t.duration>0?t.duration+' min':'No limit'}</span>
          <span>💯 ${maxScoreOf(t)} marks</span>
          ${t.dueAt?'<span>📅 Due '+fmtDate(t.dueAt)+'</span>':''}
        </div>
      </div>
    </div>
    <div class="ic-actions">
      ${done?'<button class="btn btn-ghost btn-sm" onclick="viewAttemptReview(\''+t.id+'\')">📄 View Results</button>':''}
      <button class="btn ${done?'btn-blue':'btn-primary'} btn-sm" onclick="startTest('${t.id}')">${done?'🔁 Retake Test':'▶ Start Test'}</button>
    </div>
  </div>`;
}
function viewAttemptReview(testId){
  const u=currentUser();
  const atts=DB.attempts.filter(a=>a.testId===testId && a.userId===u.id).sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt));
  if(!atts.length) return;
  goPage('testreview',{attemptId:atts[atts.length-1].id}); // most recent attempt by default
}

/* ============ STUDENT: AVAILABLE TESTS ============ */
function allPublishedTests(){ return DB.tests.filter(t=>isTestLive(t)); }
function renderAvailableTests(c){
  const u=currentUser();
  if(!window._availScope) window._availScope='mine'; // 'mine' | 'all'
  if(!window._availClassFilter) window._availClassFilter='ALL';
  if(window._availSearch===undefined)window._availSearch='';
  c.innerHTML=`<div class="page-header"><h2>Available Tests</h2><p>Tests and DPPs assigned to ${esc(className(u.cls))}, ${esc(schoolName(u.school))}.</p></div>
  <div class="page-toolbar">
    <div class="search-box"><span>🔎</span><input value="${esc(window._availSearch)}" placeholder="Search tests or subjects" oninput="window._availSearch=this.value;renderAvailableTests(document.getElementById('content'))"></div>
    <select id="availScopeSel" onchange="window._availScope=this.value;renderAvailableTests(document.getElementById('content'))" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">
      <option value="mine" ${window._availScope==='mine'?'selected':''}>My Class Only</option>
      <option value="all" ${window._availScope==='all'?'selected':''}>All Tests (every class)</option>
    </select>
    <select id="availClassSel" onchange="window._availClassFilter=this.value;renderAvailableTests(document.getElementById('content'))" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">
      ${classFilterOptions(window._availClassFilter)}
    </select>
  </div>
  <div id="availList"></div>`;
  const baseAvail = window._availScope==='all' ? allPublishedTests() : availableTestsFor(u);
  const avail=baseAvail.filter(t=>matchesClass(t,window._availClassFilter)&&matchesSearch(t,window._availSearch));
  document.getElementById('availList').innerHTML = avail.length? [...avail].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(t=>studentTestCard(t)).join('') : '<div class="empty"><div class="e-icon">📭</div><div class="e-title">No tests assigned yet</div></div>';
}

/* ============ STUDENT: MY RESULTS ============ */
function renderMyResults(c){
  const u=currentUser();
  const atts=[...userAttempts(u.id)].sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  c.innerHTML=`<div class="page-header"><h2>My Results</h2><p>Your submitted test attempts.</p></div><div id="resultsWrap"></div>`;
  const wrap=document.getElementById('resultsWrap');
  if(!atts.length){wrap.innerHTML='<div class="empty"><div class="e-icon">🏆</div><div class="e-title">No attempts yet</div></div>';return;}
  wrap.innerHTML='<div class="card"><table class="datatable"><thead><tr><th>Test</th><th>Subject</th><th>Score</th><th>%</th><th>Submitted</th><th></th></tr></thead><tbody>'+
  atts.map(a=>{
    const t=testById(a.testId); if(!t) return '';
    const mx=maxScoreOf(t); const pct=mx?Math.round(a.score/mx*100):0;
    return `<tr><td><strong>${esc(t.title)}</strong></td><td>${esc(t.subject||'—')}</td><td>${a.score} / ${mx}</td>
    <td><span class="badge ${pct>=60?'b-approved':(pct>=40?'b-pending':'b-rejected')}">${pct}%</span></td>
    <td>${fmtDate(a.submittedAt)}</td>
    <td><button class="btn btn-ghost btn-xs" onclick="goPage('testreview',{attemptId:'${a.id}'})">View</button></td></tr>`;
  }).join('')+'</tbody></table></div>';
}

/* ============ TEST TAKING FLOW ============ */
let runner=null, runnerTimerInt=null;
function startTest(testId){
  const t=testById(testId);
  runner={test:t,answers:{},current:0,startedAt:Date.now(),secondsLeft:t.duration>0?t.duration*60:null};
  goPage('testrunner',{testId});
}
function renderTestRunner(c){
  if(!runner){c.innerHTML='<div class="empty"><div class="e-icon">⚠️</div><div class="e-title">No active test</div></div>';return;}
  const t=runner.test;
  c.innerHTML=`
  <div class="card" style="margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div><h3 style="font-family:'Crimson Pro',serif;font-size:1.3rem;">${esc(t.title)}</h3><p style="font-size:.78rem;color:var(--ink3);">${esc(t.subject||'General')} · ${t.questions.length} Questions · ${maxScoreOf(t)} marks</p></div>
      ${runner.secondsLeft!=null?'<div class="timer-box" id="timerBox">--:--</div>':''}
    </div>
  </div>
  <div class="g2" style="align-items:flex-start;">
    <div class="card" style="grid-column:1/3;" id="qDisplay"></div>
  </div>
  <div class="card" style="margin-top:16px;">
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;" id="qnavGrid"></div>
    <div style="display:flex;justify-content:space-between;">
      <div>
        <button class="btn btn-ghost btn-sm" onclick="rNav(-1)">← Previous</button>
        <button class="btn btn-ghost btn-sm" onclick="rNav(1)">Next →</button>
      </div>
      <button class="btn btn-primary" onclick="confirmSubmitTest()">✅ Submit Test</button>
    </div>
  </div>`;
  renderCurrentQuestion();
  renderQNav();
  if(runner.secondsLeft!=null){
    clearInterval(runnerTimerInt);
    updateTimerDisplay();
    runnerTimerInt=setInterval(()=>{
      runner.secondsLeft--;
      updateTimerDisplay();
      if(runner.secondsLeft<=0){clearInterval(runnerTimerInt); toast('Time up! Auto-submitting...','warn'); submitTest(true);}
    },1000);
  }
}
function updateTimerDisplay(){
  const box=document.getElementById('timerBox'); if(!box) return;
  const m=Math.floor(runner.secondsLeft/60), s=runner.secondsLeft%60;
  box.textContent=(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
}
function renderCurrentQuestion(){
  const t=runner.test; const q=t.questions[runner.current];
  const dis=document.getElementById('qDisplay');
  let inputHTML='';
  if(q.type==='single'){
    inputHTML=q.options.map(o=>`<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;">
      <input type="radio" name="ans" ${runner.answers[q.id]===o.id?'checked':''} onclick="setAnswer('${q.id}','${o.id}','single')"> <span>${esc(o.text)}</span></label>`).join('');
  } else if(q.type==='multiple'){
    inputHTML=q.options.map(o=>{
      const arr=runner.answers[q.id]||[];
      return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;">
      <input type="checkbox" ${arr.includes(o.id)?'checked':''} onclick="setAnswer('${q.id}','${o.id}','multiple')"> <span>${esc(o.text)}</span></label>`;
    }).join('');
  } else {
    inputHTML=`<input type="number" style="max-width:220px;" value="${runner.answers[q.id]!=null?runner.answers[q.id]:''}" oninput="setAnswer('${q.id}',this.value,'integer')" placeholder="Enter your answer">`;
  }
  dis.innerHTML=`<div style="font-size:.72rem;color:var(--ink4);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">Question ${runner.current+1} of ${t.questions.length} · ${q.marks} mark${q.marks>1?'s':''}</div>
  <div style="font-size:1rem;font-weight:600;margin-bottom:16px;line-height:1.5;">${esc(q.text)}</div>
  ${inputHTML}`;
}
function setAnswer(qid,val,type){
  if(type==='single'){runner.answers[qid]=val;}
  else if(type==='multiple'){
    const arr=runner.answers[qid]||[];
    if(arr.includes(val)) runner.answers[qid]=arr.filter(x=>x!==val); else runner.answers[qid]=[...arr,val];
  } else { runner.answers[qid]= val===''?null:Number(val); }
  renderQNav();
}
function renderQNav(){
  const t=runner.test;
  document.getElementById('qnavGrid').innerHTML=t.questions.map((q,i)=>{
    const answered = q.type==='multiple' ? (runner.answers[q.id]&&runner.answers[q.id].length) : (runner.answers[q.id]!=null && runner.answers[q.id]!=='');
    return `<div class="qnav-btn ${answered?'answered':''} ${i===runner.current?'current':''}" onclick="jumpTo(${i})">${i+1}</div>`;
  }).join('');
}
function jumpTo(i){runner.current=i; renderCurrentQuestion(); renderQNav();}
function rNav(dir){
  const t=runner.test;
  runner.current=Math.max(0,Math.min(t.questions.length-1,runner.current+dir));
  renderCurrentQuestion(); renderQNav();
}
function confirmSubmitTest(){
  const t=runner.test;
  const answeredCount=t.questions.filter(q=>{
    const a=runner.answers[q.id];
    return q.type==='multiple'? (a&&a.length) : (a!=null && a!=='');
  }).length;
  openConfirm('Submit test?','You have answered '+answeredCount+' of '+t.questions.length+' questions. This cannot be changed after submission.',()=>submitTest(false),'Submit');
}
function submitTest(auto){
  clearInterval(runnerTimerInt);
  const t=runner.test; const u=currentUser();
  let score=0;
  t.questions.forEach(q=>{
    const a=runner.answers[q.id];
    if(q.type==='single'){ if(a!=null && a===q.correct) score+=Number(q.marks); }
    else if(q.type==='multiple'){
      if(a && a.length){
        const setA=[...a].sort().join(',');
        const setC=[...q.correct].sort().join(',');
        if(setA===setC) score+=Number(q.marks);
      }
    } else if(q.type==='integer'){ if(a!=null && Number(a)===Number(q.correct)) score+=Number(q.marks); }
  });
  const attemptId=uid('att');
  const attempt={testId:t.id,userId:u.id,answers:runner.answers,score,startedAt:new Date(runner.startedAt).toISOString(),submittedAt:nowISO(),timeTakenSec:Math.round((Date.now()-runner.startedAt)/1000)};
  dbFS.collection('attempts').doc(attemptId).set(attempt).then(()=>{
    localUpsert('attempts',attemptId,attempt);
    runner=null;
    toast(auto?'Time up — test submitted automatically':'Test submitted!','success');
    goPage('testreview',{attemptId});
  }).catch(e=>{
    toast('Failed to submit — check your connection and try again: '+friendlyError(e),'error');
  });
}

/* ============ TEST REVIEW ============ */
function renderTestReview(c){
  const att=DB.attempts.find(a=>a.id===uiState.pageParams.attemptId);
  if(!att){c.innerHTML='<div class="empty"><div class="e-icon">⚠️</div><div class="e-title">Attempt not found</div></div>';return;}
  const t=testById(att.testId);
  const mx=maxScoreOf(t); const pct=mx?Math.round(att.score/mx*100):0;
  const student=userById(att.userId);
  const allAtts=[...DB.attempts.filter(a=>a.testId===att.testId && a.userId===att.userId)].sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt));
  const attemptSelector = allAtts.length>1 ? `<div class="field" style="max-width:260px;margin-bottom:16px;"><label>Viewing Attempt</label>
    <select onchange="goPage('testreview',{attemptId:this.value})">
      ${allAtts.map((a,i)=>{
        const apct=mx?Math.round(a.score/mx*100):0;
        return `<option value="${a.id}" ${a.id===att.id?'selected':''}>Attempt ${i+1} — ${fmtDate(a.submittedAt)} (${apct}%)</option>`;
      }).join('')}
    </select></div>` : '';
  c.innerHTML=`
  <div class="page-header"><h2>${esc(t.title)} — Result</h2><p>Submitted by ${esc(student?student.name:'')} on ${fmtDate(att.submittedAt)}</p></div>
  ${attemptSelector}
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('💯','Score',att.score+' / '+mx,'var(--blue)','var(--blue-lt)')}
    ${statCard('📊','Percentage',pct+'%','var(--green)','var(--green-lt)')}
    ${statCard('⏱','Time Taken',fmtSecs(att.timeTakenSec),'var(--teal)','var(--teal-lt)')}
    ${statCard('❓','Questions',t.questions.length,'var(--purple)','var(--purple-lt)')}
  </div>
  <div class="card"><div class="card-header"><h3>Answer Review</h3></div>
  ${t.questions.map((q,i)=>reviewQuestionHTML(q,i,att)).join('')}
  </div>
  <div style="margin-top:16px;"><button class="btn btn-ghost" onclick="history.back? goBackSmart(): goPage('dashboard')">← Back</button></div>`;
}
function goBackSmart(){ const u=currentUser(); goPage(u.role==='student'?'results':'alltests'); }
function fmtSecs(s){const m=Math.floor(s/60), r=s%60; return m+'m '+r+'s';}
function reviewQuestionHTML(q,i,att){
  const a=att.answers[q.id];
  let body='';
  if(q.type==='single'||q.type==='multiple'){
    const chosenSet = q.type==='single' ? (a?[a]:[]) : (a||[]);
    body=q.options.map(o=>{
      const isCorrect=q.type==='single'? o.id===q.correct : q.correct.includes(o.id);
      const isChosen=chosenSet.includes(o.id);
      let style='padding:8px 12px;border-radius:8px;margin-bottom:6px;border:1.5px solid var(--border);';
      if(isCorrect) style+='background:var(--green-lt);border-color:var(--green);';
      else if(isChosen && !isCorrect) style+='background:var(--red-lt);border-color:var(--red);';
      return `<div style="${style}">${isChosen?'☑':'☐'} ${esc(o.text)} ${isCorrect?' ✅':''}${isChosen&&!isCorrect?' ❌':''}</div>`;
    }).join('');
  } else {
    const correct=(a!=null && Number(a)===Number(q.correct));
    body=`<div>Your answer: <strong>${a!=null?a:'—'}</strong> ${correct?'✅':'❌'}</div><div style="color:var(--ink3);font-size:.8rem;margin-top:4px;">Correct answer: ${q.correct}</div>`;
  }
  const gotMarks = (function(){
    if(q.type==='single') return a!=null && a===q.correct;
    if(q.type==='multiple') return a && a.length && [...a].sort().join(',')===[...q.correct].sort().join(',');
    return a!=null && Number(a)===Number(q.correct);
  })();
  return `<div class="qcard">
    <div class="qcard-head"><strong>Q${i+1}. ${esc(q.text)}</strong><span class="badge ${gotMarks?'b-approved':'b-rejected'}">${gotMarks?'+':''}${gotMarks?q.marks:0}/${q.marks}</span></div>
    ${body}
  </div>`;
}

/* ============ TEST ANALYTICS (teacher/admin per test) ============ */
function renderTestAnalytics(c){
  const t=testById(uiState.pageParams.testId);
  if(!t){c.innerHTML='<div class="empty"><div class="e-icon">⚠️</div><div class="e-title">Test not found</div></div>';return;}
  const atts=testAttempts(t.id);
  const mx=maxScoreOf(t);
  const avgPct= atts.length? Math.round(atts.reduce((s,a)=>s+(mx?a.score/mx*100:0),0)/atts.length):0;
  const highPct= atts.length? Math.round(Math.max(...atts.map(a=>mx?a.score/mx*100:0))):0;
  const lowPct= atts.length? Math.round(Math.min(...atts.map(a=>mx?a.score/mx*100:0))):0;
  c.innerHTML=`
  <div class="page-header"><h2>${esc(t.title)} — Analytics</h2><p>${esc(t.subject||'General')} · ${t.questions.length} questions · ${atts.length} submissions</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('🧾','Submissions',atts.length,'var(--blue)','var(--blue-lt)')}
    ${statCard('📊','Average %',avgPct+'%','var(--teal)','var(--teal-lt)')}
    ${statCard('🏆','Highest %',highPct+'%','var(--green)','var(--green-lt)')}
    ${statCard('📉','Lowest %',lowPct+'%','var(--red)','var(--red-lt)')}
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="card-header"><h3>Question-wise Accuracy</h3></div>
    <div class="bar-chart">${questionAccuracyBars(t,atts)}</div>
  </div>
  <div class="card">
    <div class="card-header"><h3>Student Submissions</h3></div>
    ${atts.length? submissionsTable(t,atts):'<div class="empty"><div class="e-icon">🧾</div><div class="e-title">No submissions yet</div></div>'}
  </div>`;
}
function questionAccuracyBars(t,atts){
  if(!atts.length) return '<div class="empty" style="width:100%"><div class="e-title">No data yet</div></div>';
  return t.questions.map((q,i)=>{
    let correct=0;
    atts.forEach(att=>{
      const a=att.answers[q.id];
      let ok=false;
      if(q.type==='single') ok = a!=null && a===q.correct;
      else if(q.type==='multiple') ok = a && a.length && [...a].sort().join(',')===[...q.correct].sort().join(',');
      else ok = a!=null && Number(a)===Number(q.correct);
      if(ok) correct++;
    });
    const pct=Math.round(correct/atts.length*100);
    return `<div class="bar-col"><div class="bar-val">${pct}%</div><div class="bar-fill" style="height:${Math.max(pct,3)}%;background:${pct>=60?'var(--green)':(pct>=40?'var(--gold)':'var(--red)')}"></div><div class="bar-lbl">Q${i+1}</div></div>`;
  }).join('');
}
function submissionsTable(t,atts){
  const mx=maxScoreOf(t);
  const sorted=[...atts].sort((a,b)=>b.score-a.score);
  return `<table class="datatable"><thead><tr><th>Student</th><th>School/Class</th><th>Score</th><th>%</th><th>Time</th><th>Submitted</th></tr></thead><tbody>
  ${sorted.map(a=>{
    const st=userById(a.userId); const pct=mx?Math.round(a.score/mx*100):0;
    return `<tr><td><strong>${esc(st?st.name:'Unknown')}</strong></td><td>${st?esc(schoolName(st.school))+' / '+esc(className(st.cls)):'—'}</td>
    <td>${a.score} / ${mx}</td><td><span class="badge ${pct>=60?'b-approved':(pct>=40?'b-pending':'b-rejected')}">${pct}%</span></td>
    <td>${fmtSecs(a.timeTakenSec)}</td><td>${fmtDate(a.submittedAt)}</td></tr>`;
  }).join('')}
  </tbody></table>`;
}

/* ============ TEACHER ANALYTICS (overview across own tests) ============ */
function renderTeacherAnalytics(c){
  const u=currentUser();
  const myTests=DB.tests.filter(t=>t.createdBy===u.id);
  const atts=DB.attempts.filter(a=>myTests.some(t=>t.id===a.testId));
  c.innerHTML=`<div class="page-header"><h2>Analytics</h2><p>Overview across all your tests and DPPs.</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('📝','Tests Created',myTests.length,'var(--blue)','var(--blue-lt)')}
    ${statCard('🧾','Total Submissions',atts.length,'var(--purple)','var(--purple-lt)')}
    ${statCard('📊','Average Score %',avgScorePct(atts,myTests)+'%','var(--teal)','var(--teal-lt)')}
    ${statCard('🎓','Unique Students',new Set(atts.map(a=>a.userId)).size,'var(--green)','var(--green-lt)')}
  </div>
  <div class="card"><div class="card-header"><h3>Score by Test</h3></div>
  <div class="bar-chart">${testScoreBars(myTests,atts)}</div></div>
  <div class="card" style="margin-top:16px;"><div class="card-header"><h3>All Tests</h3></div>
  ${myTests.length? myTests.map(t=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
    <div><strong>${esc(t.title)}</strong><div style="font-size:.75rem;color:var(--ink4);">${testAttempts(t.id).length} submissions</div></div>
    <button class="btn btn-ghost btn-sm" onclick="goPage('testanalytics',{testId:'${t.id}'})">View →</button></div>`).join(''):'<div class="empty"><div class="e-title">No tests yet</div></div>'}
  </div>`;
}
function testScoreBars(tests,atts){
  if(!tests.length) return '<div class="empty" style="width:100%"><div class="e-title">No data yet</div></div>';
  return tests.slice(0,10).map(t=>{
    const ta=atts.filter(a=>a.testId===t.id); const mx=maxScoreOf(t);
    const pct= ta.length? Math.round(ta.reduce((s,a)=>s+(mx?a.score/mx*100:0),0)/ta.length):0;
    return `<div class="bar-col"><div class="bar-val">${pct}%</div><div class="bar-fill" style="height:${Math.max(pct,3)}%;"></div><div class="bar-lbl" title="${esc(t.title)}">${esc(t.title.slice(0,10))}</div></div>`;
  }).join('');
}

/* ============ ADMIN ANALYTICS (system-wide) ============ */
function renderAdminAnalytics(c){
  const atts=DB.attempts;
  const tests=DB.tests;
  c.innerHTML=`<div class="page-header"><h2>System Analytics</h2><p>Platform-wide performance overview.</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('📝','Total Tests',tests.length,'var(--blue)','var(--blue-lt)')}
    ${statCard('🧾','Total Submissions',atts.length,'var(--purple)','var(--purple-lt)')}
    ${statCard('📊','Average Score %',avgScorePct(atts,tests)+'%','var(--teal)','var(--teal-lt)')}
    ${statCard('🎓','Active Students',DB.users.filter(u=>u.role==='student'&&u.status==='approved').length,'var(--green)','var(--green-lt)')}
  </div>
  <div class="card"><div class="card-header"><h3>Score by Test (Top 10 recent)</h3></div>
  <div class="bar-chart">${testScoreBars([...tests].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),atts)}</div></div>
  <div class="card" style="margin-top:16px;"><div class="card-header"><h3>Top Performing Teachers</h3></div>
  ${teacherLeaderboard()}
  </div>`;
}
function teacherLeaderboard(){
  const teachers=DB.users.filter(u=>u.role==='teacher'&&u.status==='approved');
  if(!teachers.length) return '<div class="empty"><div class="e-title">No teachers yet</div></div>';
  const rows=teachers.map(te=>{
    const tt=DB.tests.filter(t=>t.createdBy===te.id);
    const ta=DB.attempts.filter(a=>tt.some(t=>t.id===a.testId));
    return {name:te.name,tests:tt.length,submissions:ta.length,avg:avgScorePct(ta,tt)};
  }).sort((a,b)=>b.submissions-a.submissions);
  return '<table class="datatable"><thead><tr><th>Teacher</th><th>Tests</th><th>Submissions</th><th>Avg Score</th></tr></thead><tbody>'+
  rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${r.tests}</td><td>${r.submissions}</td><td>${r.avg}%</td></tr>`).join('')+'</tbody></table>';
}

/* ============ STUDENT ANALYTICS ============ */
function renderStudentProgress(c){
  ensureStudyMaterialsListener();
  const u=currentUser();const atts=userAttempts(u.id);const materials=DB.studyMaterials.filter(m=>matchesClass(m,u.cls));const upcoming=availableTestsFor(u).filter(t=>t.dueAt&&new Date(t.dueAt)>=new Date()).sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt));
  c.innerHTML=`<div class="page-header"><h2>My Progress</h2><p>Keep track of your study work, performance, and upcoming deadlines.</p></div><div class="g4" style="margin-bottom:20px;">${statCard('🧾','Tests Attempted',atts.length,'var(--blue)','var(--blue-lt)')}${statCard('📊','Average Score',avgScorePctForUser(u.id)+'%','var(--teal)','var(--teal-lt)')}${statCard('📚','Class Resources',materials.length,'var(--purple)','var(--purple-lt)')}${statCard('📅','Upcoming Deadlines',upcoming.length,'var(--orange)','var(--orange-lt)')}</div><div class="g2"><div class="card"><div class="card-header"><h3>Upcoming Deadlines</h3><button class="btn btn-ghost btn-xs" onclick="goPage('available')">View Tests</button></div>${upcoming.length?upcoming.slice(0,6).map(t=>`<div style="padding:10px 0;border-bottom:1px solid var(--border);"><strong>${esc(t.title)}</strong><div class="hint">Due ${fmtDate(t.dueAt)}</div></div>`).join(''):'<div class="empty" style="padding:24px;"><div class="e-sub">No upcoming test deadlines.</div></div>'}</div><div class="card"><div class="card-header"><h3>Subject Progress</h3><button class="btn btn-ghost btn-xs" onclick="goPage('analytics')">Full Analytics</button></div>${subjectAverages(atts)}</div></div>`;
}

function renderStudentAnalytics(c){
  const u=currentUser();
  const atts=[...userAttempts(u.id)].sort((a,b)=>new Date(a.submittedAt)-new Date(b.submittedAt));
  c.innerHTML=`<div class="page-header"><h2>My Analytics</h2><p>Your performance trend across all attempted tests.</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('🧾','Tests Attempted',atts.length,'var(--blue)','var(--blue-lt)')}
    ${statCard('📊','Average %',avgScorePctForUser(u.id)+'%','var(--teal)','var(--teal-lt)')}
    ${statCard('🏆','Best %',bestScorePctForUser(u.id)+'%','var(--green)','var(--green-lt)')}
    ${statCard('📚','Subjects Covered',new Set(atts.map(a=>{const t=testById(a.testId);return t?t.subject:'';})).size,'var(--purple)','var(--purple-lt)')}
  </div>
  <div class="card"><div class="card-header"><h3>Score Trend</h3></div>
  <div class="bar-chart">${studentTrendBars(atts)}</div></div>
  <div class="card" style="margin-top:16px;"><div class="card-header"><h3>Subject-wise Average</h3></div>
  ${subjectAverages(atts)}
  </div>`;
}
function studentTrendBars(atts){
  if(!atts.length) return '<div class="empty" style="width:100%"><div class="e-title">No attempts yet</div></div>';
  return atts.slice(-10).map((a,i)=>{
    const t=testById(a.testId); const mx=t?maxScoreOf(t):1; const pct=mx?Math.round(a.score/mx*100):0;
    return `<div class="bar-col"><div class="bar-val">${pct}%</div><div class="bar-fill" style="height:${Math.max(pct,3)}%;"></div><div class="bar-lbl" title="${t?esc(t.title):''}">#${i+1}</div></div>`;
  }).join('');
}
function subjectAverages(atts){
  const bySubj={};
  atts.forEach(a=>{const t=testById(a.testId); if(!t)return; const subj=t.subject||'General'; const mx=maxScoreOf(t);
    if(!bySubj[subj]) bySubj[subj]={total:0,cnt:0};
    if(mx){bySubj[subj].total+=a.score/mx*100; bySubj[subj].cnt++;}
  });
  const keys=Object.keys(bySubj);
  if(!keys.length) return '<div class="empty"><div class="e-title">No data yet</div></div>';
  return keys.map(k=>{
    const avg=Math.round(bySubj[k].total/bySubj[k].cnt);
    return `<div style="margin-bottom:14px;"><div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:5px;"><strong>${esc(k)}</strong><span>${avg}%</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${avg}%;"></div></div></div>`;
  }).join('');
}

/* ============ PROFILE ============ */
function renderProfile(c){
  const u=currentUser();
  c.innerHTML=`<div class="page-header"><h2>My Profile</h2><p>Manage your account details.</p></div>
  <div class="card" style="max-width:520px;">
    <div class="field"><label>Full Name</label><input type="text" id="pName" value="${esc(u.name)}"></div>
    <div class="field"><label>Email</label><input type="text" value="${esc(u.email)}" disabled style="opacity:.6;"></div>
    ${u.role!=='admin'?`<div class="g2">
      <div class="field"><label>School</label><input type="text" value="${esc(schoolName(u.school))}" disabled style="opacity:.6;"></div>
      <div class="field"><label>Class</label><input type="text" value="${esc(className(u.cls))}" disabled style="opacity:.6;"></div>
    </div>`:''}
    <div class="field"><label>Phone</label><input type="text" id="pPhone" value="${esc(u.phone||'')}"></div>
    ${u.role==='teacher'?'<div class="field"><label>Subject</label><input type="text" id="pSubject" value="'+esc(u.subject||'')+'"></div>':''}
    <button class="btn btn-primary" onclick="saveProfile()">💾 Save Changes</button>
    <div class="sep"></div>
    <div class="field"><label>New Password (leave blank to keep current)</label><input type="password" id="pPassword" placeholder="New password"></div>
    <button class="btn btn-ghost" onclick="changePassword()">🔒 Update Password</button>
  </div>`;
}
async function saveProfile(){
  const u=currentUser();
  const name=document.getElementById('pName').value.trim()||u.name;
  const phone=document.getElementById('pPhone').value.trim();
  const patch={name,phone};
  const subjEl=document.getElementById('pSubject');
  if(subjEl) patch.subject=subjEl.value.trim();
  try{
    const batch=dbFS.batch();
    batch.update(dbFS.collection('users').doc(u.id),patch);
    batch.set(dbFS.collection('userDirectory').doc(u.id),{name},{merge:true});
    await batch.commit();
    localUpdate('users',u.id,patch);
    toast('Profile updated','success');
    document.getElementById('sbName').textContent=name;
    document.getElementById('sbAvatar').textContent=name.charAt(0).toUpperCase();
  }catch(e){ toast('Failed to update profile: '+friendlyError(e),'error'); }
}
async function changePassword(){
  const pw=document.getElementById('pPassword').value;
  if(!pw||pw.length<6){toast('Password must be at least 6 characters','error');return;}
  try{
    await auth.currentUser.updatePassword(pw);
    toast('Password updated','success');
    document.getElementById('pPassword').value='';
  }catch(e){ toast(friendlyError(e),'error'); }
}

/* ============ PROFILE MODAL (account icon) ============ */
let pmTab='info';
function openProfileModal(){
  const u=currentUser(); if(!u) return;
  document.getElementById('pmAvatar').textContent=u.name.charAt(0).toUpperCase();
  document.getElementById('pmName').textContent=u.name;
  document.getElementById('pmEmail').textContent=u.email;
  document.getElementById('pmRoleBadge').className='badge b-'+u.role;
  document.getElementById('pmRoleBadge').textContent=u.role.charAt(0).toUpperCase()+u.role.slice(1);
  pmTab='info';
  markProfileModalTab();
  renderProfileModalContent();
  document.getElementById('profileModalOverlay').classList.remove('hidden');
}
function closeProfileModal(){document.getElementById('profileModalOverlay').classList.add('hidden');}
function switchProfileModalTab(t){pmTab=t; markProfileModalTab(); renderProfileModalContent();}
function markProfileModalTab(){
  document.getElementById('pmTabInfo').classList.toggle('active',pmTab==='info');
  document.getElementById('pmTabStats').classList.toggle('active',pmTab==='stats');
  document.getElementById('pmTabSecurity').classList.toggle('active',pmTab==='security');
}
function renderProfileModalContent(){
  const u=currentUser();
  const el=document.getElementById('pmContent');
  if(pmTab==='info'){
    el.innerHTML=`
    <div class="field"><label>Full Name</label><input type="text" id="pmFieldName" value="${esc(u.name)}"></div>
    <div class="g2">
      <div class="field"><label>Phone</label><input type="text" id="pmFieldPhone" value="${esc(u.phone||'')}"></div>
      ${u.role==='teacher'?'<div class="field"><label>Subject</label><input type="text" id="pmFieldSubject" value="'+esc(u.subject||'')+'"></div>':'<div></div>'}
    </div>
    ${u.role!=='admin'?`<div class="g2">
      <div class="field"><label>School</label><input type="text" value="${esc(schoolName(u.school))}" disabled style="opacity:.6;"></div>
      <div class="field"><label>Class</label><input type="text" value="${esc(className(u.cls))}" disabled style="opacity:.6;"></div>
    </div>`:''}
    <button class="btn btn-primary" onclick="saveProfileModalInfo()">💾 Save Changes</button>`;
  } else if(pmTab==='stats'){
    el.innerHTML = profileStatsHTML(u);
  } else {
    el.innerHTML=`
    <div class="field"><label>New Password</label><input type="password" id="pmNewPw" placeholder="min 6 characters"></div>
    <div class="field"><label>Confirm New Password</label><input type="password" id="pmNewPw2" placeholder="repeat password"></div>
    <button class="btn btn-primary" onclick="savePasswordModal()">🔒 Update Password</button>
    <div class="sep"></div>
    <div style="font-size:.78rem;color:var(--ink3);">Account created: ${fmtDate(u.createdAt)}</div>
    <div style="font-size:.78rem;color:var(--ink3);margin-top:4px;">Status: <span class="badge b-${u.status}">${u.status}</span></div>`;
  }
}
function profileStatsHTML(u){
  if(u.role==='student'){
    const atts=userAttempts(u.id);
    return `<div class="g3">
      ${miniStat('Tests Attempted',atts.length)}
      ${miniStat('Average %',avgScorePctForUser(u.id)+'%')}
      ${miniStat('Best %',bestScorePctForUser(u.id)+'%')}
    </div>`;
  } else if(u.role==='teacher'){
    const myTests=DB.tests.filter(t=>t.createdBy===u.id);
    const atts=DB.attempts.filter(a=>myTests.some(t=>t.id===a.testId));
    return `<div class="g3">
      ${miniStat('Tests Created',myTests.length)}
      ${miniStat('Submissions',atts.length)}
      ${miniStat('Avg Score %',avgScorePct(atts,myTests)+'%')}
    </div>`;
  } else {
    return `<div class="g3">
      ${miniStat('Total Users',DB.users.filter(x=>x.role!=='admin').length)}
      ${miniStat('Total Tests',DB.tests.length)}
      ${miniStat('Total Attempts',DB.attempts.length)}
    </div>`;
  }
}
async function saveProfileModalInfo(){
  const u=currentUser();
  const name=document.getElementById('pmFieldName').value.trim()||u.name;
  const phone=document.getElementById('pmFieldPhone').value.trim();
  const patch={name,phone};
  const subjEl=document.getElementById('pmFieldSubject');
  if(subjEl) patch.subject=subjEl.value.trim();
  try{
    const batch=dbFS.batch();
    batch.update(dbFS.collection('users').doc(u.id),patch);
    batch.set(dbFS.collection('userDirectory').doc(u.id),{name},{merge:true});
    await batch.commit();
    localUpdate('users',u.id,patch);
    document.getElementById('sbName').textContent=name;
    document.getElementById('sbAvatar').textContent=name.charAt(0).toUpperCase();
    document.getElementById('tbAvatarBtn').textContent=name.charAt(0).toUpperCase();
    document.getElementById('pmName').textContent=name;
    document.getElementById('pmAvatar').textContent=name.charAt(0).toUpperCase();
    toast('Profile updated','success');
  }catch(e){ toast('Failed to update profile: '+friendlyError(e),'error'); }
}
async function savePasswordModal(){
  const pw=document.getElementById('pmNewPw').value;
  const pw2=document.getElementById('pmNewPw2').value;
  if(!pw||pw.length<6){toast('Password must be at least 6 characters','error');return;}
  if(pw!==pw2){toast('Passwords do not match','error');return;}
  try{
    await auth.currentUser.updatePassword(pw);
    toast('Password updated','success');
    document.getElementById('pmNewPw').value=''; document.getElementById('pmNewPw2').value='';
  }catch(e){ toast(friendlyError(e),'error'); }
}

/* ============ PRE-LOGIN HELP & SUPPORT (no account needed) ============ */
function genTicketNo(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoids visually-confusing chars
  let s=''; for(let i=0;i<6;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return 'PH-'+s;
}
// Ticket numbers are random and used as the Firestore document ID. Previously
// nothing checked whether a freshly-generated number already belonged to an
// existing ticket before writing to it with .set() — an (unlikely, but real)
// collision would have silently overwritten someone else's ticket with no
// error shown to anyone. This generates a number, checks it's actually free,
// and retries with a new one on the rare collision instead of failing silently.
async function genUniqueTicketNo(){
  for(let attempt=0; attempt<8; attempt++){
    const candidate=genTicketNo();
    try{
      const doc=await dbFS.collection('tickets').doc(candidate).get();
      if(!doc.exists) return candidate;
    }catch(e){
      // couldn't verify uniqueness (e.g. offline) — surface it rather than
      // silently proceeding with an unverified ticket number
      throw e;
    }
  }
  throw new Error('Could not generate a unique ticket number — please try again.');
}
function openHelpSupport(tab){
  document.getElementById('helpSupportOverlay').classList.remove('hidden');
  document.getElementById('hsSubmitForm').style.display='block';
  document.getElementById('hsSubmitSuccess').style.display='none';
  document.getElementById('hsTrackResult').innerHTML='';
  hsSwitchTab(tab==='track'?'track':'submit');
}
function closeHelpSupport(){
  document.getElementById('helpSupportOverlay').classList.add('hidden');
}
function hsSwitchTab(t){
  document.getElementById('hsTabSubmitBtn').classList.toggle('active',t==='submit');
  document.getElementById('hsTabTrackBtn').classList.toggle('active',t==='track');
  document.getElementById('hsPanelSubmit').style.display=t==='submit'?'block':'none';
  document.getElementById('hsPanelTrack').style.display=t==='track'?'block':'none';
}
async function submitPublicTicket(){
  const name=document.getElementById('hsName').value.trim();
  const email=document.getElementById('hsEmail').value.trim();
  const phone=document.getElementById('hsPhone').value.trim();
  const category=document.getElementById('hsCategory').value;
  const subject=document.getElementById('hsSubject').value.trim();
  const message=document.getElementById('hsMessage').value.trim();
  if(!name||!email||!subject||!message){toast('Please fill in all required fields','error');return;}
  const btn=document.getElementById('hsSubmitBtn');
  if(btn){btn.disabled=true; btn.textContent='Submitting...';}
  try{
    const ticketNo=await genUniqueTicketNo();
    const data={ticketNo,userId:null,name,email,phone,category,subject,message,status:'Open',thread:[],createdAt:nowISO()};
    await dbFS.collection('tickets').doc(ticketNo).set(data);
    document.getElementById('hsTicketNo').textContent=ticketNo;
    document.getElementById('hsSubmitForm').style.display='none';
    document.getElementById('hsSubmitSuccess').style.display='block';
  }catch(e){
    toast('Failed to submit: '+friendlyError(e),'error');
  }finally{
    if(btn){btn.disabled=false; btn.textContent='📨 Submit Query';}
  }
}
function hsGoTrackJustSubmitted(){
  const tn=document.getElementById('hsTicketNo').textContent;
  hsSwitchTab('track');
  document.getElementById('hsTrackInput').value=tn;
  trackPublicTicket();
}
// Shared thread renderer — used by the public tracker, the logged-in "My Queries"
// list, and the admin ticket console, so every reply anyone sends looks the same
// everywhere and is easy to follow chronologically.
function ticketThreadHTML(t){
  const thread=t.thread||[];
  if(!thread.length) return '<p class="modal-sub" style="margin-top:10px;">No replies yet.</p>';
  return '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">'+thread.map(m=>{
    const isAdmin=m.who==='admin';
    return `<div style="align-self:${isAdmin?'flex-start':'flex-end'};max-width:88%;">
      <div class="ticket-reply-box" style="margin-top:0;${isAdmin?'':'background:var(--blue-lt);border-left-color:var(--blue);'}">
        <strong>${isAdmin?'🛡️ Admin':'💬 '+esc(m.name||'You')}:</strong> ${esc(m.text)}
        <div style="font-size:.68rem;color:var(--ink4);margin-top:4px;">${fmtDate(m.at)}</div>
      </div>
    </div>`;
  }).join('')+'</div>';
}
async function trackPublicTicket(){
  const raw=document.getElementById('hsTrackInput').value.trim().toUpperCase();
  if(!raw){toast('Enter a ticket number','error');return;}
  await doTrackTicket(raw);
}
async function doTrackTicket(raw){
  const resultEl=document.getElementById('hsTrackResult');
  resultEl.innerHTML='<p class="modal-sub">Searching…</p>';
  try{
    const doc=await dbFS.collection('tickets').doc(raw).get();
    if(!doc.exists){
      resultEl.innerHTML='<div class="empty"><div class="e-icon">🔍</div><div class="e-title">Not found</div><div class="e-sub">Double-check the ticket number and try again.</div></div>';
      return;
    }
    const t=doc.data();
    const statusClass=t.status==='Open'?'b-open':(t.status==='In Progress'?'b-inprogress':'b-resolved');
    const canReply = t.userId==null; // anonymous ticket — the tracker is only for those; logged-in owners reply from Help & Support instead
    resultEl.innerHTML=`<div class="item-card" style="margin-top:14px;">
      <div class="ic-title">${esc(t.subject)} <span class="badge b-teacher">${esc(t.category)}</span> <span class="badge ${statusClass}">${t.status}</span></div>
      <div class="ic-meta"><span>🕒 ${fmtDate(t.createdAt)}</span></div>
      <div style="font-size:.82rem;color:var(--ink2);margin-top:8px;line-height:1.6;">${esc(t.message)}</div>
      ${ticketThreadHTML(t)}
      ${canReply?`<div style="display:flex;gap:8px;margin-top:12px;">
        <input type="text" id="hsReplyInput" placeholder="Write a reply..." style="flex:1;" onkeydown="if(event.key==='Enter')sendPublicTicketReply('${raw}','${esc(t.name).replace(/'/g,"&#39;")}')">
        <button class="btn btn-primary btn-sm" onclick="sendPublicTicketReply('${raw}','${esc(t.name).replace(/'/g,"&#39;")}')">Send</button>
      </div>`:''}
    </div>`;
  }catch(e){
    resultEl.innerHTML='<div class="empty"><div class="e-icon">⚠️</div><div class="e-title">Could not fetch</div><div class="e-sub">'+esc(friendlyError(e))+'</div></div>';
  }
}
async function sendPublicTicketReply(ticketNo,name){
  const input=document.getElementById('hsReplyInput');
  const text=input.value.trim();
  if(!text) return;
  input.disabled=true;
  const entry={who:'user',name,text,at:nowISO()};
  try{
    await dbFS.collection('tickets').doc(ticketNo).update({thread:firebase.firestore.FieldValue.arrayUnion(entry)});
    await doTrackTicket(ticketNo);
  }catch(e){
    toast('Failed to send reply: '+friendlyError(e),'error');
    input.disabled=false;
  }
}

/* ============ HELP & SUPPORT / QUERY TICKETS (inside the app, logged in) ============ */
function openTicketCount(){return DB.tickets.filter(t=>t.status==='Open').length;}
function myTicketCount(userId){return DB.tickets.filter(t=>t.userId===userId).length;}

function renderSupport(c){
  const u=currentUser();
  const myTickets=[...DB.tickets].filter(t=>t.userId===u.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  c.innerHTML=`
  <div class="page-header"><h2>Help &amp; Support</h2><p>Raise a query or report an issue — reply back and forth with the admin right here.</p></div>
  <div class="g2" style="align-items:flex-start;">
    <div class="card">
      <div class="card-header"><h3>📨 Raise a New Query</h3></div>
      <div class="field"><label>Category</label><select id="tkCategory">
        <option value="Query">General Query</option>
        <option value="Bug">Bug / Technical Issue</option>
        <option value="Test Issue">Test / Question Issue</option>
        <option value="Account">Account / Access Issue</option>
        <option value="Other">Other</option>
      </select></div>
      <div class="field"><label>Subject <span class="req">*</span></label><input type="text" id="tkSubject" placeholder="Short summary of your query"></div>
      <div class="field"><label>Message <span class="req">*</span></label><textarea id="tkMessage" placeholder="Describe your query or issue in detail..." style="min-height:110px;"></textarea></div>
      <button class="btn btn-primary btn-full" onclick="submitTicket()">📨 Submit Query</button>
    </div>
    <div class="card">
      <div class="card-header"><h3>🗂️ My Queries (${myTickets.length})</h3></div>
      <div id="myTicketsWrap"></div>
    </div>
  </div>`;
  const wrap=document.getElementById('myTicketsWrap');
  wrap.innerHTML = myTickets.length? myTickets.map(t=>myTicketCardHTML(t)).join('') : '<div class="empty"><div class="e-icon">🗂️</div><div class="e-title">No queries yet</div><div class="e-sub">Anything you raise will show up here.</div></div>';
}
function myTicketCardHTML(t){
  const statusClass=t.status==='Open'?'b-open':(t.status==='In Progress'?'b-inprogress':'b-resolved');
  return `<div class="item-card">
    <div class="ic-top">
      <div style="width:100%;"><div class="ic-title">${esc(t.subject)} <span class="badge b-teacher">${esc(t.category)}</span> <span class="badge ${statusClass}">${t.status}</span></div>
      <div class="ic-meta"><span>🎫 ${esc(t.ticketNo||t.id)}</span><span>🕒 ${fmtDate(t.createdAt)}</span></div>
      <div style="font-size:.82rem;color:var(--ink2);margin-top:8px;line-height:1.6;">${esc(t.message)}</div>
      ${ticketThreadHTML(t)}
      <div style="display:flex;gap:8px;margin-top:12px;">
        <input type="text" id="myReplyInput_${t.id}" placeholder="Write a reply..." style="flex:1;" onkeydown="if(event.key==='Enter')sendMyTicketReply('${t.id}')">
        <button class="btn btn-primary btn-sm" onclick="sendMyTicketReply('${t.id}')">Send</button>
      </div>
      </div>
    </div>
  </div>`;
}
async function sendMyTicketReply(id){
  const input=document.getElementById('myReplyInput_'+id);
  const text=input.value.trim();
  if(!text) return;
  const u=currentUser();
  const entry={who:'user',name:u.name,text,at:nowISO()};
  input.disabled=true;
  try{
    await dbFS.collection('tickets').doc(id).update({thread:firebase.firestore.FieldValue.arrayUnion(entry)});
    input.value='';
  }catch(e){ toast('Failed to send reply: '+friendlyError(e),'error'); }
  finally{ input.disabled=false; }
}
async function submitTicket(){
  const category=document.getElementById('tkCategory').value;
  const subject=document.getElementById('tkSubject').value.trim();
  const message=document.getElementById('tkMessage').value.trim();
  if(!subject||!message){toast('Please fill in subject and message','error');return;}
  const u=currentUser();
  try{
    const ticketNo=await genUniqueTicketNo();
    const data={ticketNo,userId:u.id,name:u.name,email:u.email,phone:u.phone||'',category,subject,message,status:'Open',thread:[],createdAt:nowISO()};
    await dbFS.collection('tickets').doc(ticketNo).set(data);
    localUpsert('tickets',ticketNo,data);
    toast('Query submitted (ticket '+ticketNo+') — admin will respond soon','success');
    buildNav();
    renderSupport(document.getElementById('content'));
  }catch(e){ toast('Failed to submit: '+friendlyError(e),'error'); }
}

function renderSupportTickets(c){
  const total=DB.tickets.length;
  const open=DB.tickets.filter(t=>t.status==='Open').length;
  const inprog=DB.tickets.filter(t=>t.status==='In Progress').length;
  const resolved=DB.tickets.filter(t=>t.status==='Resolved').length;
  const categories=[...new Set(DB.tickets.map(t=>t.category).filter(Boolean))].sort();
  c.innerHTML=`<div class="page-header"><h2>Support Tickets</h2><p>Every query ever raised, fully trackable — filter, search, and delete as needed.</p></div>
  <div class="g4" style="margin-bottom:20px;">
    ${statCard('🗂️','Total Tickets',total,'var(--blue)','var(--blue-lt)')}
    ${statCard('🟡','Open',open,'var(--gold)','var(--gold-lt)')}
    ${statCard('🔵','In Progress',inprog,'var(--blue)','var(--blue-lt)')}
    ${statCard('🟢','Resolved',resolved,'var(--green)','var(--green-lt)')}
  </div>
  <div class="page-toolbar">
    <div class="search-box">🔍<input type="text" id="ticketSearch" placeholder="Search by subject, ticket #, or user..." oninput="renderTicketsList()"></div>
    <select id="ticketCategoryFilter" onchange="renderTicketsList()" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.78rem;background:var(--surface);color:var(--ink);">
      <option value="all">All Categories</option>
      ${categories.map(cat=>'<option value="'+esc(cat)+'">'+esc(cat)+'</option>').join('')}
    </select>
    <button class="filter-btn active" data-tf="all" onclick="setTicketFilter('all')">All</button>
    <button class="filter-btn" data-tf="Open" onclick="setTicketFilter('Open')">Open</button>
    <button class="filter-btn" data-tf="In Progress" onclick="setTicketFilter('In Progress')">In Progress</button>
    <button class="filter-btn" data-tf="Resolved" onclick="setTicketFilter('Resolved')">Resolved</button>
  </div>
  <div id="ticketsList"></div>`;
  window._ticketFilter='all';
  renderTicketsList();
}
function setTicketFilter(f){
  window._ticketFilter=f;
  document.querySelectorAll('[data-tf]').forEach(b=>b.classList.toggle('active',b.dataset.tf===f));
  renderTicketsList();
}
function renderTicketsList(){
  const q=(document.getElementById('ticketSearch')?.value||'').toLowerCase();
  const f=window._ticketFilter||'all';
  const cat=document.getElementById('ticketCategoryFilter')?.value||'all';
  let list=[...DB.tickets].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  if(f!=='all') list=list.filter(t=>t.status===f);
  if(cat!=='all') list=list.filter(t=>t.category===cat);
  if(q) list=list.filter(t=>{
    const u=t.userId?userById(t.userId):null;
    const name=u?u.name:(t.name||'');
    return t.subject.toLowerCase().includes(q) || name.toLowerCase().includes(q) || (t.ticketNo||'').toLowerCase().includes(q);
  });
  const wrap=document.getElementById('ticketsList');
  if(!list.length){wrap.innerHTML='<div class="empty"><div class="e-icon">🗂️</div><div class="e-title">No queries found</div></div>';return;}
  wrap.innerHTML=list.map(t=>adminTicketCardHTML(t)).join('');
}
function deleteTicket(id){
  const t=DB.tickets.find(x=>x.id===id); if(!t) return;
  openConfirm('Delete ticket '+(t.ticketNo||id)+'?','This permanently removes the ticket and its reply history. This cannot be undone.',async()=>{
    try{
      await dbFS.collection('tickets').doc(id).delete();
      localRemove('tickets',id);
      toast('Ticket deleted','success');
      buildNav();
      renderTicketsList();
    }catch(e){ toast('Failed to delete: '+friendlyError(e),'error'); }
  },'Delete');
}
function adminTicketCardHTML(t){
  const u=t.userId?userById(t.userId):null;
  const statusClass=t.status==='Open'?'b-open':(t.status==='In Progress'?'b-inprogress':'b-resolved');
  const whoLabel = u ? esc(u.name) : esc(t.name||'Unknown')+' (not logged in)';
  const roleLabel = u ? esc(u.role) : 'visitor';
  const contactLine = !u && (t.email||t.phone) ? `<div class="ic-meta"><span>✉️ ${esc(t.email||'—')}</span>${t.phone?'<span>📞 '+esc(t.phone)+'</span>':''}</div>` : '';
  return `<div class="item-card">
    <div class="ic-top">
      <div>
        <div class="ic-title">${esc(t.subject)} <span class="badge b-teacher">${esc(t.category)}</span> <span class="badge ${statusClass}">${t.status}</span></div>
        <div class="ic-meta">
          <span>🎫 ${esc(t.ticketNo||t.id)}</span>
          <span>👤 ${whoLabel}</span>
          <span>🏷️ ${roleLabel}</span>
          <span>🕒 ${fmtDate(t.createdAt)}</span>
        </div>
        ${contactLine}
        <div style="font-size:.82rem;color:var(--ink2);margin-top:8px;line-height:1.6;">${esc(t.message)}</div>
        ${ticketThreadHTML(t)}
      </div>
    </div>
    <div class="ic-actions">
      <select id="statusSel_${t.id}" onchange="updateTicketStatus('${t.id}')" style="padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.77rem;">
        <option value="Open" ${t.status==='Open'?'selected':''}>Open</option>
        <option value="In Progress" ${t.status==='In Progress'?'selected':''}>In Progress</option>
        <option value="Resolved" ${t.status==='Resolved'?'selected':''}>Resolved</option>
      </select>
      <input type="text" id="replyInput_${t.id}" placeholder="Write a reply..." style="flex:1;min-width:160px;padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:.8rem;" onkeydown="if(event.key==='Enter')replyTicket('${t.id}')">
      <button class="btn btn-primary btn-xs" onclick="replyTicket('${t.id}')">📨 Send Reply</button>
      <button class="btn btn-danger btn-xs" onclick="deleteTicket('${t.id}')">🗑 Delete</button>
    </div>
  </div>`;
}
async function updateTicketStatus(id){
  const status=document.getElementById('statusSel_'+id).value;
  try{
    await dbFS.collection('tickets').doc(id).update({status});
    localUpdate('tickets',id,{status});
    toast('Status updated to '+status,'success');
    buildNav();
  }catch(e){ toast('Failed to update status: '+friendlyError(e),'error'); }
}
async function replyTicket(id){
  const input=document.getElementById('replyInput_'+id);
  const text=input.value.trim();
  if(!text){toast('Write a reply first','error');return;}
  const entry={who:'admin',name:'Admin',text,at:nowISO()};
  input.disabled=true;
  try{
    await dbFS.collection('tickets').doc(id).update({thread:firebase.firestore.FieldValue.arrayUnion(entry)});
    input.value='';
    toast('Reply sent','success');
  }catch(e){ toast('Failed to reply: '+friendlyError(e),'error'); }
  finally{ input.disabled=false; }
}

/* ============ MESSAGES: direct 1:1, plus group & class chats ============
   Own messages (direct or group) can be edited, deleted, or copied via the
   small action row that appears under each of your own message bubbles.
*/
let chatState={mode:'direct', otherUserId:null, messages:[], msgUnsub:null,
               groupId:null, groupMessages:[], groupMsgUnsub:null, editingId:null};
let msgsTab='direct'; // 'direct' | 'groups'
function convoId(a,b){ return [a,b].sort().join('__'); }
function otherParticipant(convo){ return convo.participants.find(p=>p!==currentProfile.id); }

function renderMessages(c){
  c.innerHTML=`
  <div class="page-header"><h2>Messages</h2><p>Direct messages, group chats, and class group chats.</p></div>
  <div class="card" style="display:flex;height:70vh;overflow:hidden;padding:0;">
    <div style="width:260px;flex-shrink:0;border-right:1.5px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;">
      <div class="profile-tabs" style="margin:10px 10px 0;">
        <div class="profile-tab ${msgsTab==='direct'?'active':''}" onclick="switchMsgsTab('direct')">Direct</div>
        <div class="profile-tab ${msgsTab==='groups'?'active':''}" onclick="switchMsgsTab('groups')">Groups &amp; Class</div>
      </div>
      <div style="padding:12px;border-bottom:1.5px solid var(--border);">
        <button class="btn btn-primary btn-sm btn-full" id="msgsNewBtn" onclick="${msgsTab==='direct'?'openNewChatPicker()':'openNewGroupModal()'}">${msgsTab==='direct'?'✉️ New Message':'👥 New Group'}</button>
      </div>
      <div id="convoListWrap" style="flex:1;overflow-y:auto;${msgsTab!=='direct'?'display:none;':''}"></div>
      <div id="groupListWrap" style="flex:1;overflow-y:auto;${msgsTab!=='groups'?'display:none;':''}"></div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
      <div id="chatHeader" style="padding:14px 18px;border-bottom:1.5px solid var(--border);font-weight:700;display:flex;align-items:center;justify-content:space-between;gap:10px;"></div>
      <div id="chatMessages" style="flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:10px;"></div>
      <div id="chatInputWrap" style="padding:12px;border-top:1.5px solid var(--border);"></div>
    </div>
  </div>`;
  renderConvoList();
  renderGroupList();
  if(chatState.mode==='group' && chatState.groupId) openGroupChat(chatState.groupId);
  else if(chatState.mode==='direct' && chatState.otherUserId) openChat(chatState.otherUserId);
  else renderChatEmptyState();
}
function switchMsgsTab(t){
  msgsTab=t;
  document.querySelectorAll('.profile-tab').forEach(el=>{}); // no-op, re-render handles classes
  render();
}
function renderChatEmptyState(){
  const h=document.getElementById('chatHeader'); if(h) h.innerHTML='';
  const m=document.getElementById('chatMessages');
  if(m) m.innerHTML='<div class="empty"><div class="e-icon">💬</div><div class="e-title">No conversation open</div><div class="e-sub">Pick someone from the left, or start something new.</div></div>';
  const i=document.getElementById('chatInputWrap'); if(i) i.innerHTML='';
}
function renderConvoList(){
  const wrap=document.getElementById('convoListWrap');
  if(!wrap) return; // page navigated away
  const sorted=[...DB.conversations].sort((a,b)=>new Date(b.lastMessageAt||b.createdAt||0)-new Date(a.lastMessageAt||a.createdAt||0));
  if(!sorted.length){ wrap.innerHTML='<div class="empty" style="padding:20px;"><div class="e-icon">📭</div><div class="e-sub">No conversations yet</div></div>'; return; }
  wrap.innerHTML=sorted.map(convo=>{
    const otherId=otherParticipant(convo);
    const other=userById(otherId);
    const active=chatState.mode==='direct' && chatState.otherUserId===otherId;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;${active?'background:var(--brand-lt);':''}" onclick="openChat('${otherId}')">
      <div style="width:32px;height:32px;flex-shrink:0;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;">${esc((other?other.name:'?').charAt(0).toUpperCase())}</div>
      <div style="overflow:hidden;">
        <div style="font-weight:600;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(other?other.name:'Unknown user')} <span style="font-weight:400;color:var(--ink4);font-size:.7rem;">(${esc(other?other.role:'')})</span></div>
        <div style="font-size:.74rem;color:var(--ink4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(convo.lastMessage||'')}</div>
      </div>
    </div>`;
  }).join('');
}
function renderGroupList(){
  const wrap=document.getElementById('groupListWrap');
  if(!wrap) return;
  const invites=[...(DB.groupInvites||[])].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  const invitesHTML = invites.length ? `<div style="padding:10px 14px 4px;font-size:.7rem;font-weight:700;color:var(--ink4);text-transform:uppercase;letter-spacing:.03em;">Group Invites (${invites.length})</div>` +
    invites.map(g=>{
      const inviter=userById(g.createdBy);
      return `<div class="item-card" style="margin:6px 10px;">
        <div class="ic-title" style="font-size:.85rem;">${g.type==='class'?'🏷️':'👥'} ${esc(g.name)}</div>
        <div style="font-size:.72rem;color:var(--ink4);margin:2px 0 8px;">Invited by ${esc(inviter?inviter.name:'someone')} · ${g.participants.length} member(s)</div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-primary btn-xs" onclick="acceptGroupInvite('${g.id}')">✓ Accept</button>
          <button class="btn btn-ghost btn-xs" onclick="declineGroupInvite('${g.id}')">✕ Decline</button>
        </div>
      </div>`;
    }).join('') + '<div style="border-bottom:1.5px solid var(--border);margin:4px 0 6px;"></div>'
    : '';
  const sorted=[...DB.groupChats].sort((a,b)=>new Date(b.lastMessageAt||b.createdAt||0)-new Date(a.lastMessageAt||a.createdAt||0));
  if(!sorted.length && !invites.length){ wrap.innerHTML='<div class="empty" style="padding:20px;"><div class="e-icon">👥</div><div class="e-sub">No group or class chats yet</div></div>'; return; }
  const listHTML = sorted.length ? sorted.map(g=>{
    const active=chatState.mode==='group' && chatState.groupId===g.id;
    const amAdmin=(g.admins||[]).includes(currentProfile.id);
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;${active?'background:var(--brand-lt);':''}" onclick="openGroupChat('${g.id}')">
      <div style="width:32px;height:32px;flex-shrink:0;border-radius:9px;background:var(--purple);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;">${g.type==='class'?'🏷️':'👥'}</div>
      <div style="overflow:hidden;">
        <div style="font-weight:600;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(g.name)} <span style="font-weight:400;color:var(--ink4);font-size:.7rem;">(${g.participants.length})</span>${amAdmin?' <span class="badge b-admin" style="font-size:.6rem;">admin</span>':''}</div>
        <div style="font-size:.74rem;color:var(--ink4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(g.lastMessage||'No messages yet')}</div>
      </div>
    </div>`;
  }).join('') : (invites.length?'':'<div class="empty" style="padding:20px;"><div class="e-icon">👥</div><div class="e-sub">No group or class chats yet</div></div>');
  wrap.innerHTML=invitesHTML+listHTML;
}
async function acceptGroupInvite(id){
  const g=(DB.groupInvites||[]).find(x=>x.id===id); if(!g) return;
  const me=currentProfile.id;
  try{
    await dbFS.collection('groupChats').doc(id).update({
      participants: firebase.firestore.FieldValue.arrayUnion(me),
      invites: firebase.firestore.FieldValue.arrayRemove(me)
    });
    toast('Joined "'+g.name+'"','success');
    msgsTab='groups'; render(); openGroupChat(id);
  }catch(e){ toast('Failed to join group: '+friendlyError(e),'error'); }
}
async function declineGroupInvite(id){
  const me=currentProfile.id;
  try{
    await dbFS.collection('groupChats').doc(id).update({invites: firebase.firestore.FieldValue.arrayRemove(me)});
    toast('Invite declined','success');
  }catch(e){ toast('Failed to decline invite: '+friendlyError(e),'error'); }
}
function openNewChatPicker(){
  const me=currentUser();
  const others=contactDirectory();
  const pickerHTML=`
  <div class="overlay" id="newChatOverlay" style="z-index:600;">
    <div class="modal modal-wide">
      <h3>New Message</h3>
      <p class="modal-sub">Pick anyone to message — teachers, students, or admins.</p>
      <input type="text" id="newChatSearch" placeholder="Search by name..." oninput="filterNewChatList()" style="margin-bottom:10px;">
      <div id="newChatList" style="max-height:320px;overflow-y:auto;"></div>
      <div class="modal-btns"><button class="btn btn-ghost" onclick="document.getElementById('newChatOverlay').remove()">Cancel</button></div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend',pickerHTML);
  window._newChatUsers=others;
  filterNewChatList();
}
function filterNewChatList(){
  const q=(document.getElementById('newChatSearch')?.value||'').toLowerCase();
  const list=(window._newChatUsers||[]).filter(u=>u.name.toLowerCase().includes(q));
  const wrap=document.getElementById('newChatList');
  if(!wrap) return;
  wrap.innerHTML=list.length? list.map(u=>`<div class="item-card" style="cursor:pointer;margin-bottom:6px;" onclick="document.getElementById('newChatOverlay').remove();msgsTab='direct';render();openChat('${u.id}')">
    <div class="ic-title">${esc(u.name)} <span class="badge b-${u.role==='admin'?'admin':(u.role==='teacher'?'teacher':'student')}">${esc(u.role)}</span></div>
  </div>`).join('') : '<div class="empty"><div class="e-sub">No matches</div></div>';
}

/* ---- New Group / Class group modal ---- */
function openNewGroupModal(){
  const me=currentUser();
  const others=contactDirectory();
  const classOpts=['<option value="">— pick a class to auto-add everyone in it —</option>'].concat(
    DB.classes.map(cl=>'<option value="'+cl.id+'">'+esc(cl.name)+'</option>')
  ).join('');
  const html=`
  <div class="overlay" id="newGroupOverlay" style="z-index:600;">
    <div class="modal modal-wide">
      <h3>New Group Chat</h3>
      <p class="modal-sub">Create a custom group, or auto-pick everyone in a class. You'll be the group's admin — everyone you add gets an <strong>invite</strong> and only joins once they accept, nobody is added without their say-so.</p>
      <div class="field"><label>Group Name <span class="req">*</span></label><input type="text" id="ngName" placeholder="e.g. JEE Batch A Doubts"></div>
      <div class="field"><label>Auto-invite from Class (optional)</label><select id="ngClass" onchange="ngApplyClassPick()">${classOpts}</select></div>
      <div class="field"><label>Members to Invite</label>
        <input type="text" id="ngMemberSearch" placeholder="Search by name to add manually..." oninput="renderNgMemberList()">
      </div>
      <div id="ngMemberList" style="max-height:220px;overflow-y:auto;border:1.5px solid var(--border);border-radius:8px;padding:6px;"></div>
      <div id="ngSelectedWrap" style="margin-top:10px;"></div>
      <div class="modal-btns">
        <button class="btn btn-ghost" onclick="document.getElementById('newGroupOverlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="createGroupChat()">Create &amp; Send Invites</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend',html);
  window._ngAllUsers=others;
  window._ngSelected=new Set();
  window._ngIsClass=false;
  renderNgMemberList();
  renderNgSelected();
}
function ngApplyClassPick(){
  const clsId=document.getElementById('ngClass').value;
  if(!clsId){ window._ngIsClass=false; return; }
  window._ngIsClass=true;
  window._ngSelected=new Set(window._ngAllUsers.filter(u=>u.cls===clsId).map(u=>u.id));
  const nameEl=document.getElementById('ngName');
  if(!nameEl.value.trim()) nameEl.value=className(clsId)+' — Class Group';
  renderNgMemberList(); renderNgSelected();
}
function renderNgMemberList(){
  const q=(document.getElementById('ngMemberSearch')?.value||'').toLowerCase();
  const list=(window._ngAllUsers||[]).filter(u=>u.name.toLowerCase().includes(q));
  const wrap=document.getElementById('ngMemberList');
  if(!wrap) return;
  wrap.innerHTML=list.length? list.map(u=>{
    const checked=window._ngSelected.has(u.id);
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:6px;">
      <input type="checkbox" ${checked?'checked':''} onchange="ngToggleMember('${u.id}',this.checked)">
      <span style="font-size:.82rem;">${esc(u.name)} <span style="color:var(--ink4);font-size:.7rem;">(${esc(u.role)})</span></span>
    </label>`;
  }).join('') : '<div class="empty" style="padding:10px;"><div class="e-sub">No matches</div></div>';
}
function ngToggleMember(uid,checked){
  if(checked) window._ngSelected.add(uid); else window._ngSelected.delete(uid);
  renderNgSelected();
}
function renderNgSelected(){
  const wrap=document.getElementById('ngSelectedWrap'); if(!wrap) return;
  const ids=[...window._ngSelected];
  if(!ids.length){ wrap.innerHTML='<p class="hint">No members selected yet.</p>'; return; }
  wrap.innerHTML='<div style="font-size:.72rem;color:var(--ink3);margin-bottom:6px;">'+ids.length+' member(s) selected:</div>'+
    ids.map(id=>{
      const u=userById(id);
      return '<span class="tag-chip">'+esc(u?u.name:'Unknown')+' <button onclick="ngToggleMember(\''+id+'\',false);renderNgMemberList();renderNgSelected();">✕</button></span>';
    }).join('');
}
async function createGroupChat(){
  const name=document.getElementById('ngName').value.trim();
  const invitees=[...window._ngSelected].filter(id=>id!==currentProfile.id);
  if(!name){toast('Enter a group name','error');return;}
  if(!invitees.length){toast('Pick at least one person to invite','error');return;}
  const me=currentProfile.id;
  const id=uid('grp');
  // Only the creator is seated as a participant (and admin) right away — everyone
  // else lands in `invites` and only becomes a member once THEY accept, so nobody
  // gets forced into a group.
  const data={name,type:window._ngIsClass?'class':'group',participants:[me],invites:invitees,admins:[me],createdBy:me,createdAt:nowISO(),lastMessage:'',lastMessageAt:nowISO()};
  try{
    await dbFS.collection('groupChats').doc(id).set(data);
    document.getElementById('newGroupOverlay').remove();
    toast('Group created — invite'+(invitees.length>1?'s':'')+' sent to '+invitees.length+' member(s)','success');
    msgsTab='groups'; render();
    openGroupChat(id);
  }catch(e){ toast('Failed to create group: '+friendlyError(e),'error'); }
}
function deleteGroupChat(id){
  openConfirm('Delete this group?','This removes the group chat for everyone in it. This cannot be undone.',async()=>{
    try{
      await dbFS.collection('groupChats').doc(id).delete();
      if(chatState.groupId===id){ chatState.mode='direct'; chatState.groupId=null; if(chatState.groupMsgUnsub){chatState.groupMsgUnsub();chatState.groupMsgUnsub=null;} }
      toast('Group deleted','success');
      render();
    }catch(e){ toast('Failed to delete group: '+friendlyError(e),'error'); }
  },'Delete');
}
// ---- Leave a group (any member can leave; if the last admin leaves, everyone
// still in the group is auto-promoted so it's never left admin-less/stuck) ----
function leaveGroupChat(id){
  const g=DB.groupChats.find(x=>x.id===id); if(!g) return;
  openConfirm('Leave "'+g.name+'"?','You will stop receiving messages from this group unless someone invites you back.',async()=>{
    const me=currentProfile.id;
    const remaining=(g.participants||[]).filter(p=>p!==me);
    try{
      if(!remaining.length){
        // last person in the group leaving — just remove the group entirely
        await dbFS.collection('groupChats').doc(id).delete();
      } else {
        const adminsMinusMe=(g.admins||[]).filter(a=>a!==me);
        const newAdmins = adminsMinusMe.length ? adminsMinusMe : remaining.slice();
        await dbFS.collection('groupChats').doc(id).update({
          participants: firebase.firestore.FieldValue.arrayRemove(me),
          admins: newAdmins
        });
      }
      if(chatState.groupId===id){ chatState.mode='direct'; chatState.groupId=null; if(chatState.groupMsgUnsub){chatState.groupMsgUnsub();chatState.groupMsgUnsub=null;} }
      const ov=document.getElementById('groupSettingsOverlay'); if(ov) ov.remove();
      toast('You left the group','success');
      render();
    }catch(e){ toast('Failed to leave group: '+friendlyError(e),'error'); }
  },'Leave');
}

/* ---- Direct chat ---- */
function openChat(otherUserId){
  chatState.mode='direct';
  chatState.otherUserId=otherUserId;
  if(chatState.groupMsgUnsub){ chatState.groupMsgUnsub(); chatState.groupMsgUnsub=null; }
  chatState.groupId=null; chatState.editingId=null;
  if(chatState.msgUnsub){ chatState.msgUnsub(); chatState.msgUnsub=null; }
  chatState.messages=[];
  const other=userById(otherUserId);
  const headerEl=document.getElementById('chatHeader');
  if(headerEl) headerEl.innerHTML='<span>'+esc(other?other.name:'Unknown user')+' <span style="font-weight:400;color:var(--ink4);font-size:.8rem;">('+esc(other?other.role:'')+')</span></span>';
  renderChatInput();
  const cid=convoId(currentProfile.id,otherUserId);
  // No orderBy here on purpose: an equality filter (conversationId) combined with
  // orderBy on a DIFFERENT field (createdAt) requires a Firestore composite index
  // to be created in the console first, and fails with "query requires an index"
  // until you do. Sorting client-side avoids needing any index setup at all.
  chatState.msgUnsub=dbFS.collection('messages').where('conversationId','==',cid)
    .onSnapshot(snap=>{
      chatState.messages=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
      renderChatMessages();
    }, e=>toast('Sync error (chat): '+friendlyError(e),'error'));
  renderConvoList();
}

/* ---- Group / class chat ---- */
function openGroupChat(groupId){
  chatState.mode='group';
  chatState.groupId=groupId;
  chatState.otherUserId=null; chatState.editingId=null;
  if(chatState.msgUnsub){ chatState.msgUnsub(); chatState.msgUnsub=null; }
  if(chatState.groupMsgUnsub){ chatState.groupMsgUnsub(); chatState.groupMsgUnsub=null; }
  chatState.groupMessages=[];
  const g=DB.groupChats.find(x=>x.id===groupId);
  const headerEl=document.getElementById('chatHeader');
  if(headerEl) headerEl.innerHTML='<span>'+(g&&g.type==='class'?'🏷️ ':'👥 ')+esc(g?g.name:'Unknown group')+' <span style="font-weight:400;color:var(--ink4);font-size:.8rem;">('+(g?g.participants.length:0)+' members)</span></span>'+
    (g?'<button class="btn btn-ghost btn-xs" onclick="openGroupSettings(\''+groupId+'\')">⚙️ Group Info</button>':'');
  renderChatInput();
  chatState.groupMsgUnsub=dbFS.collection('groupMessages').where('groupId','==',groupId)
    .onSnapshot(snap=>{
      chatState.groupMessages=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
      renderChatMessages();
    }, e=>toast('Sync error (group chat): '+friendlyError(e),'error'));
  renderGroupList();
}
function isCurrentUserAdmin(){ const u=currentUser(); return u&&u.role==='admin'; }

/* ---- Group Info / Settings modal (WhatsApp-style: admin-only controls) ---- */
function openGroupSettings(groupId){
  const g=DB.groupChats.find(x=>x.id===groupId); if(!g) return;
  const me=currentProfile.id;
  const amAdmin=(g.admins||[]).includes(me) || isCurrentUserAdmin();
  const html=`
  <div class="overlay" id="groupSettingsOverlay" style="z-index:600;">
    <div class="modal modal-wide">
      <h3>${g.type==='class'?'🏷️':'👥'} Group Info</h3>
      ${amAdmin?`<div class="field"><label>Group Name</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="gsName" value="${esc(g.name)}" style="flex:1;">
          <button class="btn btn-primary btn-sm" onclick="renameGroupChat('${groupId}')">Save</button>
        </div>
      </div>`:`<p class="modal-sub">${esc(g.name)}</p>`}
      <div class="field"><label>Members (${g.participants.length})</label>
        <div id="gsMemberList" style="max-height:180px;overflow-y:auto;border:1.5px solid var(--border);border-radius:8px;padding:6px;"></div>
      </div>
      ${amAdmin?`
      <div class="field"><label>Pending Invites (${(g.invites||[]).length})</label>
        <div id="gsInviteList" style="max-height:120px;overflow-y:auto;border:1.5px solid var(--border);border-radius:8px;padding:6px;"></div>
      </div>
      <div class="field"><label>Invite More People</label>
        <input type="text" id="gsAddSearch" placeholder="Search by name..." oninput="renderGsAddList('${groupId}')">
        <div id="gsAddList" style="max-height:140px;overflow-y:auto;margin-top:6px;"></div>
      </div>`:''}
      <div class="modal-btns" style="flex-wrap:wrap;">
        ${amAdmin?'<button class="btn btn-danger" onclick="document.getElementById(\'groupSettingsOverlay\').remove();deleteGroupChat(\''+groupId+'\')">🗑 Delete Group</button>':''}
        <button class="btn btn-danger" style="margin-left:auto;" onclick="leaveGroupChat('${groupId}')">🚪 Leave Group</button>
        <button class="btn btn-ghost" onclick="document.getElementById('groupSettingsOverlay').remove()">Close</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend',html);
  renderGsMemberList(groupId);
  if(amAdmin){ renderGsInviteList(groupId); renderGsAddList(groupId); }
}
function renderGsMemberList(groupId){
  const wrap=document.getElementById('gsMemberList'); if(!wrap) return;
  const g=DB.groupChats.find(x=>x.id===groupId); if(!g) return;
  const me=currentProfile.id;
  const amAdmin=(g.admins||[]).includes(me) || isCurrentUserAdmin();
  wrap.innerHTML=g.participants.map(pid=>{
    const u=userById(pid);
    const isAdminMember=(g.admins||[]).includes(pid);
    const isMe=pid===me;
    let controls='';
    if(amAdmin && !isMe){
      controls = isAdminMember
        ? `<button class="btn btn-ghost btn-xs" onclick="demoteFromGroupAdmin('${groupId}','${pid}')">Remove Admin</button>`
        : `<button class="btn btn-ghost btn-xs" onclick="promoteToGroupAdmin('${groupId}','${pid}')">Make Admin</button>`;
      controls += ` <button class="btn btn-ghost btn-xs" style="color:var(--red);" onclick="removeGroupMember('${groupId}','${pid}')">Remove</button>`;
    }
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;">
      <span style="font-size:.82rem;">${esc(u?u.name:'Unknown')}${isMe?' (you)':''} <span style="color:var(--ink4);font-size:.7rem;">(${esc(u?u.role:'')})</span>${isAdminMember?' <span class="badge b-admin" style="font-size:.6rem;">admin</span>':''}</span>
      <span style="display:flex;gap:4px;flex-shrink:0;">${controls}</span>
    </div>`;
  }).join('');
}
function renderGsInviteList(groupId){
  const wrap=document.getElementById('gsInviteList'); if(!wrap) return;
  const g=DB.groupChats.find(x=>x.id===groupId); if(!g) return;
  const invites=g.invites||[];
  wrap.innerHTML=invites.length? invites.map(pid=>{
    const u=userById(pid);
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;">
      <span style="font-size:.82rem;">${esc(u?u.name:'Unknown')} <span style="color:var(--ink4);font-size:.7rem;">(invited)</span></span>
      <button class="btn btn-ghost btn-xs" onclick="cancelGroupInvite('${groupId}','${pid}')">Cancel</button>
    </div>`;
  }).join('') : '<div class="hint" style="padding:4px 8px;">No pending invites.</div>';
}
function renderGsAddList(groupId){
  const wrap=document.getElementById('gsAddList'); if(!wrap) return;
  const g=DB.groupChats.find(x=>x.id===groupId); if(!g) return;
  const q=(document.getElementById('gsAddSearch')?.value||'').toLowerCase();
  const already=new Set([...(g.participants||[]),...(g.invites||[])]);
  const list=contactDirectory().filter(u=>!already.has(u.id) && u.name.toLowerCase().includes(q));
  wrap.innerHTML=list.length? list.slice(0,20).map(u=>`<div class="item-card" style="cursor:pointer;margin-bottom:4px;padding:6px 8px;" onclick="inviteMoreToGroup('${groupId}','${u.id}')">
    <span style="font-size:.8rem;">${esc(u.name)} <span style="color:var(--ink4);font-size:.7rem;">(${esc(u.role)})</span></span>
  </div>`).join('') : '<div class="hint" style="padding:4px 8px;">No matches.</div>';
}
async function renameGroupChat(groupId){
  const name=(document.getElementById('gsName').value||'').trim();
  if(!name){toast('Group name cannot be empty','error');return;}
  try{
    await dbFS.collection('groupChats').doc(groupId).update({name});
    toast('Group renamed','success');
  }catch(e){ toast('Failed to rename group: '+friendlyError(e),'error'); }
}
async function promoteToGroupAdmin(groupId,uidToPromote){
  try{
    await dbFS.collection('groupChats').doc(groupId).update({admins: firebase.firestore.FieldValue.arrayUnion(uidToPromote)});
    toast('Promoted to admin','success');
    renderGsMemberList(groupId);
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
async function demoteFromGroupAdmin(groupId,uidToDemote){
  const g=DB.groupChats.find(x=>x.id===groupId); if(!g) return;
  if((g.admins||[]).length<=1){ toast('A group needs at least one admin — promote someone else first','error'); return; }
  try{
    await dbFS.collection('groupChats').doc(groupId).update({admins: firebase.firestore.FieldValue.arrayRemove(uidToDemote)});
    toast('Admin removed','success');
    renderGsMemberList(groupId);
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
function removeGroupMember(groupId,uidToRemove){
  const g=DB.groupChats.find(x=>x.id===groupId); if(!g) return;
  const u=userById(uidToRemove);
  openConfirm('Remove '+(u?u.name:'this member')+'?','They will stop receiving messages from this group.',async()=>{
    try{
      await dbFS.collection('groupChats').doc(groupId).update({
        participants: firebase.firestore.FieldValue.arrayRemove(uidToRemove),
        admins: firebase.firestore.FieldValue.arrayRemove(uidToRemove)
      });
      toast('Member removed','success');
      renderGsMemberList(groupId);
    }catch(e){ toast('Failed to remove member: '+friendlyError(e),'error'); }
  },'Remove');
}
async function cancelGroupInvite(groupId,uidToCancel){
  try{
    await dbFS.collection('groupChats').doc(groupId).update({invites: firebase.firestore.FieldValue.arrayRemove(uidToCancel)});
    toast('Invite cancelled','success');
    renderGsInviteList(groupId); renderGsAddList(groupId);
  }catch(e){ toast('Failed: '+friendlyError(e),'error'); }
}
async function inviteMoreToGroup(groupId,uidToInvite){
  try{
    await dbFS.collection('groupChats').doc(groupId).update({invites: firebase.firestore.FieldValue.arrayUnion(uidToInvite)});
    toast('Invite sent','success');
    renderGsInviteList(groupId); renderGsAddList(groupId);
  }catch(e){ toast('Failed to invite: '+friendlyError(e),'error'); }
}

function renderChatInput(){
  const inputWrap=document.getElementById('chatInputWrap');
  if(!inputWrap) return;
  inputWrap.innerHTML=`<div style="display:flex;gap:8px;">
    <input type="text" id="chatMsgInput" placeholder="Type a message..." style="flex:1;" onkeydown="if(event.key==='Enter')sendChatMessage()">
    <button class="btn btn-primary" onclick="sendChatMessage()">Send</button>
  </div>`;
}

/* ---- Rendering messages (shared for direct + group) with edit/delete/copy ---- */
function renderChatMessages(){
  const wrap=document.getElementById('chatMessages');
  if(!wrap) return;
  const isGroup=chatState.mode==='group';
  const list=isGroup?chatState.groupMessages:chatState.messages;
  if(!list.length){ wrap.innerHTML='<div class="empty"><div class="e-icon">👋</div><div class="e-sub">Say hello \u2014 no messages yet.</div></div>'; return; }
  const me=currentProfile.id;
  wrap.innerHTML=list.map(m=>{
    const mine=m.senderId===me;
    const sender=isGroup?userById(m.senderId):null;
    const isEditing=chatState.editingId===m.id;
    const bubbleId='bub_'+m.id;
    let inner;
    if(isEditing){
      inner=`<div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="editInput_${m.id}" value="${esc(m.text)}" style="min-width:160px;" onkeydown="if(event.key==='Enter')saveEditedMessage('${m.id}');if(event.key==='Escape')cancelEditMessage();">
        <button class="btn btn-success btn-xs" onclick="saveEditedMessage('${m.id}')">💾</button>
        <button class="btn btn-ghost btn-xs" onclick="cancelEditMessage()">✕</button>
      </div>`;
    } else {
      inner=`<div style="background:${mine?'var(--brand)':'var(--bg2,#f1f1f1)'};color:${mine?'#fff':'inherit'};padding:8px 12px;border-radius:12px;font-size:.86rem;line-height:1.4;white-space:pre-wrap;word-break:break-word;">${isGroup&&!mine?'<div style="font-size:.68rem;font-weight:700;opacity:.75;margin-bottom:2px;">'+esc(sender?sender.name:'Unknown')+'</div>':''}${esc(m.text)}${m.edited?' <span style="opacity:.6;font-size:.68rem;">(edited)</span>':''}</div>`;
    }
    const actions=`<div class="msg-actions" style="display:flex;gap:8px;margin-top:2px;font-size:.68rem;justify-content:${mine?'flex-end':'flex-start'};">
      <button class="btn btn-ghost btn-xs" style="padding:2px 6px;" onclick="copyMessageText('${m.id}')" title="Copy">📋 Copy</button>
      ${mine&&!isEditing?'<button class="btn btn-ghost btn-xs" style="padding:2px 6px;" onclick="startEditMessage(\''+m.id+'\')" title="Edit">✏️ Edit</button>':''}
      ${mine?'<button class="btn btn-ghost btn-xs" style="padding:2px 6px;color:var(--red);" onclick="deleteChatMessage(\''+m.id+'\')" title="Delete">🗑 Delete</button>':''}
    </div>`;
    return `<div id="${bubbleId}" data-text="${esc(m.text)}" style="align-self:${mine?'flex-end':'flex-start'};max-width:70%;">
      ${inner}
      <div style="font-size:.68rem;color:var(--ink4);margin-top:2px;text-align:${mine?'right':'left'};">${fmtDate(m.createdAt)}</div>
      ${actions}
    </div>`;
  }).join('');
  wrap.scrollTop=wrap.scrollHeight;
}
function startEditMessage(id){ chatState.editingId=id; renderChatMessages(); setTimeout(()=>{const el=document.getElementById('editInput_'+id); if(el){el.focus(); el.select();}},0); }
function cancelEditMessage(){ chatState.editingId=null; renderChatMessages(); }
async function saveEditedMessage(id){
  const input=document.getElementById('editInput_'+id);
  const text=input.value.trim();
  if(!text){toast('Message cannot be empty','error');return;}
  const coll=chatState.mode==='group'?'groupMessages':'messages';
  try{
    await dbFS.collection(coll).doc(id).update({text,edited:true,editedAt:nowISO()});
    chatState.editingId=null;
  }catch(e){ toast('Failed to edit: '+friendlyError(e),'error'); }
}
function deleteChatMessage(id){
  openConfirm('Delete this message?','This cannot be undone.',async()=>{
    const coll=chatState.mode==='group'?'groupMessages':'messages';
    try{ await dbFS.collection(coll).doc(id).delete(); }
    catch(e){ toast('Failed to delete: '+friendlyError(e),'error'); }
  },'Delete');
}
function copyMessageText(id){
  const el=document.getElementById('bub_'+id);
  const text=el?el.dataset.text:'';
  if(!text) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>toast('Copied to clipboard','success')).catch(()=>toast('Could not copy','error'));
  } else {
    toast('Clipboard not available in this browser','error');
  }
}

/* ---- Sending ---- */
async function sendChatMessage(){
  const input=document.getElementById('chatMsgInput');
  const text=input.value.trim();
  if(!text) return;
  if(chatState.mode==='group'){
    if(!chatState.groupId) return;
    const me=currentProfile.id, groupId=chatState.groupId;
    input.value=''; input.disabled=true;
    try{
      await dbFS.collection('groupChats').doc(groupId).set({lastMessage:text,lastMessageAt:nowISO()},{merge:true});
      await dbFS.collection('groupMessages').add({groupId,senderId:me,text,createdAt:nowISO()});
    }catch(e){
      toast('Failed to send: '+friendlyError(e),'error');
      input.value=text;
    }finally{
      input.disabled=false; input.focus();
    }
  } else {
    if(!chatState.otherUserId) return;
    const me=currentProfile.id, other=chatState.otherUserId;
    const cid=convoId(me,other);
    input.value=''; input.disabled=true;
    try{
      await dbFS.collection('conversations').doc(cid).set({
        participants:[me,other], lastMessage:text, lastMessageAt:nowISO(), createdAt:nowISO()
      }, {merge:true});
      await dbFS.collection('messages').add({
        conversationId:cid, senderId:me, receiverId:other, text, createdAt:nowISO()
      });
    }catch(e){
      toast('Failed to send: '+friendlyError(e),'error');
      input.value=text;
    }finally{
      input.disabled=false; input.focus();
    }
  }
}

/* ============ INIT ============ */
function init(){
  initDark();
  attachPublicListeners(); // schools/classes, needed on the registration form pre-login
  populateRegSelects();
  // Login/logout/app-entry itself is driven by auth.onAuthStateChanged() above,
  // which fires once automatically on page load with whatever session Firebase
  // Auth already has persisted (or null, if nobody is logged in).
}
init();
