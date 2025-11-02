// src/helpers/loja.js
const supabaseDb = require('../supabase/supabaseDb');

// mantém só dígitos
const onlyDigits = (s) => (s || '').replace(/\D/g, '');

async function ensureLoja({
  usuarioId,
  tipo,                // 'PJ' | 'PF'
  nomeFantasia,
  cnpj,
  cpf,
  cidade,
  estado,
  descricao,
  icone_url,
  nota
}) {
  if (!usuarioId) throw new Error('usuarioId é obrigatório em ensureLoja');

  const documentoRaw = tipo === 'PJ' ? cnpj : cpf;
  const documento = onlyDigits(documentoRaw);
  const doc_tipo = documento
    ? (documento.length === 14 ? 'CNPJ' : (documento.length === 11 ? 'CPF' : null))
    : null;

  const nome_fantasia = String(nomeFantasia || 'Minha Loja').trim();
  const nota_num = Number.isFinite(Number(nota)) ? Number(nota) : 0;
  const iconeSanit = (icone_url && String(icone_url).trim() !== '' && icone_url !== 'null')
    ? icone_url
    : null;

  const payload = {
    usuario_id: usuarioId,
    nome_fantasia,
    doc_tipo,                       // enum doc_tipo (ou null)
    documento: documento || null,   // único em lojas (ver índice abaixo)
    cidade: cidade ?? null,
    estado: estado ?? null,
    descricao: descricao ?? null,
    icone_url: iconeSanit,
    nota: nota_num
  };

  const { error } = await supabaseDb
    .from('lojas')
    .upsert(payload, { onConflict: 'usuario_id' }); // exige índice único em usuario_id

  if (error) {
    if ((error.message || '').toLowerCase().includes('duplicate key value')) {
      throw new Error('Documento (CPF/CNPJ) já está em uso em outra loja.');
    }
    throw error;
  }

  // // opcional: se quiser a linha de volta:
  // const { data } = await supabaseDb
  //   .from('lojas')
  //   .select('*')
  //   .eq('usuario_id', usuarioId)
  //   .single();
  // return data;
}

module.exports = { ensureLoja, onlyDigits };
