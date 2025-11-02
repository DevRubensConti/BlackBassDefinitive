// diagnose.js
require('dotenv').config();

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!url || !key) {
  console.log('Faltam SUPABASE_URL ou SUPABASE_SERVICE_ROLE no .env');
  process.exit(1);
}

// Decodifica o JWT (NÃO logar ele inteiro)
try {
  const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString());

  // Exibe infos úteis para checagem (sem vazar segredos)
  console.log('URL (.env):', url);
  console.log('Key prefix  :', key.slice(0, 12) + '...');
  console.log('JWT role    :', payload.role);            // precisa ser "service_role"
  console.log('JWT iss     :', payload.iss);             // deve bater com seu projeto
  console.log('JWT aud     :', payload.aud);             // normalmente "authenticated" ou similar

  // Checa se a URL bate com o projeto do token
  const refFromUrl = (url.match(/https:\/\/([^.]+)\.supabase\.co/) || [])[1];
  const refFromIss = (payload.iss && payload.iss.match(/https:\/\/([^.]+)\.supabase\.co/) || [])[1];
  console.log('Project ref (URL):', refFromUrl);
  console.log('Project ref (JWT):', refFromIss);

  if (payload.role !== 'service_role') {
    console.log('❌ Essa chave NÃO é service_role. Copie a Service Role Key em Project Settings → API → Service role.');
  } else if (refFromUrl && refFromIss && refFromUrl !== refFromIss) {
    console.log('❌ A Service Role pertence a OUTRO PROJETO. Copie a Service Role do MESMO projeto do SUPABASE_URL.');
  } else {
    console.log('✅ Chave parece ser service_role do projeto correto.');
  }
} catch (e) {
  console.error('Falha ao decodificar a chave. Ela parece ser válida? Erro:', e.message);
}
