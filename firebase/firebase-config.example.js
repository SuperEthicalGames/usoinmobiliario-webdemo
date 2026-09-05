// Copia este archivo a firebase-config.js (sin ".example") y reemplaza los valores
// por los reales de tu proyecto: Firebase Console → ⚙️ Configuración del proyecto →
// "Tus apps" → app web → "Config".
//
// Importante: databaseURL debe ser el de Realtime Database (termina en
// "...firebasedatabase.app" o "...firebaseio.com"), NO el de Firestore.
export const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  databaseURL: "https://TU_PROYECTO-default-rtdb.firebaseio.com",
  projectId: "TU_PROYECTO",
  appId: "TU_APP_ID"
  // storageBucket/messagingSenderId/measurementId pueden quedarse si Firebase los da por
  // defecto — no hacen daño en el objeto. La regla real es no LLAMAR nunca getStorage()/
  // uploadBytes() en el código, no borrar el campo del config.
};
