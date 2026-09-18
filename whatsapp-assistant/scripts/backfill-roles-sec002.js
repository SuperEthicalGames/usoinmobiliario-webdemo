// SEC-002 (auditoría 2026-09-16) — script de una sola vez.
//
// adminAuth.attachRole va a dejar de tratar "sin documento en roles/{uid}" como 'admin' por
// defecto (fail-open) y va a empezar a rechazar esas cuentas con 403 (fail-closed) — ver el
// comentario de attachRole en src/adminAuth.js para el porqué. Antes de desplegar ESE cambio,
// toda cuenta admin real que hoy dependa del default implícito necesita su roles/{uid} escrito
// de forma explícita, o quedaría bloqueada del panel el día del despliegue.
//
// Qué hace: lista las cuentas reales de Firebase Auth (admin.auth().listUsers), y para cada una
// que NO sea el super admin (config.superAdminEmail) y que todavía no tenga un documento en
// roles/{uid}, escribe { role: 'admin', createdAt, createdBy: 'backfill-audit-2026-09-16' }.
// Nunca toca al owner (nunca vive en roles/) ni a una cuenta que ya tiene un rol documentado
// (employee o admin) — es puramente aditivo, no borra ni sobreescribe nada.
//
// Cómo correrlo (una sola vez, ANTES de desplegar el cambio de adminAuth.js a Render):
//   cd whatsapp-assistant
//   node scripts/backfill-roles-sec002.js
//
// Requiere las mismas variables de entorno que el servidor real (.env local con
// FIREBASE_SERVICE_ACCOUNT_JSON/PATH apuntando a una cuenta de servicio con permiso de
// Admin SDK sobre el proyecto real) — este script usa el mismo firebase.js que el servidor.

const config = require('../config');
const fb = require('../src/firebase');

async function main() {
  fb.init();
  const users = await fb.listAdminUsers();
  console.log(`Cuentas de Firebase Auth encontradas: ${users.length}`);
  let backfilled = 0, skippedOwner = 0, skippedHasRole = 0;
  for (const u of users) {
    if (u.email === config.superAdminEmail) { skippedOwner++; continue; }
    const existingRole = await fb.getUserRole(u.uid);
    if (existingRole) {
      skippedHasRole++;
      console.log(`  ya tiene rol '${existingRole}', sin tocar: ${u.uid} (${u.email})`);
      continue;
    }
    await fb.setUserRole(u.uid, 'admin', 'backfill-audit-2026-09-16');
    backfilled++;
    console.log(`  backfill -> 'admin': ${u.uid} (${u.email})`);
  }
  console.log(`\nResumen: ${backfilled} cuenta(s) recibieron roles/{uid}='admin' explícito, ${skippedHasRole} ya tenían rol, ${skippedOwner} owner (sin tocar).`);
  console.log('\nAhora sí es seguro desplegar el cambio de adminAuth.js (fail-closed).');
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR en el backfill (nada se hizo a medias — cada escritura es independiente, revisa el log de arriba para ver hasta dónde llegó):', err);
  process.exit(1);
});
