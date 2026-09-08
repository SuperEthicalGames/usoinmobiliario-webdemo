const config = require('../config');
const app = require('./app');

// Entrada SOLO para desarrollo local (`node src/server.js`) — arranca la misma app de
// Express que index.js expone como Cloud Function. En producción (Cloud Functions/Hosting)
// nunca se ejecuta este archivo; Firebase invoca la app directamente vía onRequest().
app.listen(config.port, () => {
  console.log(`[server] Asistente de Uso Inmobiliario escuchando en puerto ${config.port}`);
});
