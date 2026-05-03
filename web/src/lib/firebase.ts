import { FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const FUNCTIONS_REGION = "europe-west1";

let cachedApp: FirebaseApp | null = null;

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("Firebase browser SDK can only be used in the browser.");
  }
}

function getFirebaseApp() {
  assertBrowser();

  if (cachedApp) {
    return cachedApp;
  }

  const missingValues = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingValues.length > 0) {
    throw new Error(
      `Missing Firebase web environment values: ${missingValues.join(", ")}. Fill web/.env.local first.`,
    );
  }

  cachedApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return cachedApp;
}

export function getFirebaseWebConfig() {
  getFirebaseApp();
  return firebaseConfig as {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
  };
}

export function getClientAuth() {
  return getAuth(getFirebaseApp());
}

export function getClientDb() {
  return getFirestore(getFirebaseApp());
}

export function getClientFunctions() {
  return getFunctions(getFirebaseApp(), FUNCTIONS_REGION);
}
