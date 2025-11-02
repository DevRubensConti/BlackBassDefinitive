// Node 18+ já tem fetch nativo
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Faltou GEMINI_API_KEY no .env");
  process.exit(1);
}

const BASE = "https://generativelanguage.googleapis.com/v1";

async function main() {
  try {
    const res = await fetch(`${BASE}/models?key=${API_KEY}`);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();
    console.log("Modelos disponíveis (v1):");
    data.models
      // mostre só os que suportam generateContent
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .forEach(m => {
        console.log(`- ${m.name}`);
      });
  } catch (err) {
    console.error("Erro ao listar modelos:", err);
  }
}

main();
