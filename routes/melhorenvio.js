// routes/melhorenvio.js
const express = require('express');
const supabaseDb = require('../supabase/supabaseDb');
const {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  melhorEnvioRequest
} = require('../services/melhorEnvio');

const router = express.Router();

/**
 * Helper: converte expires_in em expires_at (ISO)
 */
function calcExpiresAt(expiresInSec) {
  const base = Date.now();
  const ms = (expiresInSec || 3600) * 1000;
  return new Date(base + ms).toISOString();
}

/**
 * Helper: busca token da loja e renova se necessário
 */
async function getValidAccessToken(lojaId) {
  const { data: row, error } = await supabaseDb
    .from('melhorenvio_tokens')
    .select('access_token, refresh_token, expires_in, token_type, created_at, expires_at')
    .eq('loja_id', lojaId)
    .maybeSingle();

  if (error) {
    console.error('[ME][TOKEN] Erro ao buscar token no Supabase:', error);
    throw new Error('Erro ao buscar token do Melhor Envio no banco.');
  }

  if (!row || !row.access_token) {
    throw new Error('Nenhum token do Melhor Envio encontrado para esta loja.');
  }

  const now = Date.now();

  let expiresAtMs;
  if (row.expires_at) {
    // Novo formato: usa expires_at direto
    expiresAtMs = new Date(row.expires_at).getTime();
  } else {
    // Legado: calcula usando created_at + expires_in
    const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : now;
    const expiresInMs = (row.expires_in || 3600) * 1000;
    expiresAtMs = createdAtMs + expiresInMs;
  }

  // Renova se faltam menos de 5 minutos para expirar
  const willExpireSoon = !expiresAtMs || now > expiresAtMs - 5 * 60 * 1000;

  if (!willExpireSoon || !row.refresh_token) {
    return row.access_token;
  }

  console.log('[ME][TOKEN] Token próximo de expirar. Renovando via refresh_token…');

  const newTokens = await refreshAccessToken(row.refresh_token);

  const expiresAt = calcExpiresAt(newTokens.expires_in || row.expires_in);

  const { error: upsertErr } = await supabaseDb
    .from('melhorenvio_tokens')
    .upsert(
      {
        loja_id: lojaId,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || row.refresh_token,
        expires_in: newTokens.expires_in || row.expires_in,
        token_type: newTokens.token_type || row.token_type || 'Bearer',
        created_at: new Date().toISOString(),
        expires_at: expiresAt
      },
      { onConflict: 'loja_id' }
    );

  if (upsertErr) {
    console.error('[ME][TOKEN] Erro ao salvar token renovado no Supabase:', upsertErr);
    throw new Error('Erro ao salvar token renovado do Melhor Envio.');
  }

  console.log('[ME][TOKEN] Token renovado com sucesso para loja:', lojaId);
  return newTokens.access_token;
}

/**
 * GET /integracoes/melhorenvio/connect
 * Inicia o fluxo OAuth do Melhor Envio.
 * O vendedor precisa estar logado e possuir uma loja criada.
 */
router.get('/integracoes/melhorenvio/connect', async (req, res) => {
  try {
    const usr = req.session?.usuario || {};

    if (!usr.id) {
      return res.redirect('/login');
    }

    // Busca a loja cadastrada para este vendedor
    const { data: loja, error: lojaErr } = await supabaseDb
      .from('lojas')
      .select('id')
      .eq('usuario_id', usr.id)
      .maybeSingle();

    if (lojaErr || !loja) {
      console.error('[ME][CONNECT] Usuário não possui loja cadastrada:', lojaErr);
      return res
        .status(400)
        .send('Você precisa criar sua loja antes de conectar com o Melhor Envio.');
    }

    const lojaId = loja.id;

    // Gera STATE seguro contendo loja_id
    const state = `${lojaId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    req.session.me_state = state;

    // Monta URL de autorização
    const url = buildAuthorizeUrl(state);
    console.log('[ME][CONNECT] Redirecionando para URL de autorização:', url);
    return res.redirect(url);
  } catch (err) {
    console.error('[ME][CONNECT] EXCEPTION:', err);
    return res.status(500).send('Erro ao iniciar integração com Melhor Envio.');
  }
});

/**
 * GET /integracoes/melhorenvio/callback
 * Endpoint configurado como Redirect URI no painel do Melhor Envio.
 * Recebe ?code= e troca por tokens.
 */
router.get('/integracoes/melhorenvio/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error('[ME][CALLBACK] Erro recebido do Melhor Envio:', {
        error,
        error_description
      });
      return res.status(400).send('Erro ao autorizar sua conta no Melhor Envio.');
    }

    if (!code) {
      return res.status(400).send('Code não informado pelo Melhor Envio.');
    }

    // validação de STATE
    if (!state || state !== req.session.me_state) {
      console.warn('[ME][CALLBACK] STATE INVÁLIDO:', {
        recebido: state,
        esperado: req.session.me_state
      });
      return res.status(400).send('State inválido. Processo cancelado por segurança.');
    }

    // extrai loja_id do STATE
    const [lojaId] = state.split(':');

    if (!lojaId) {
      return res.status(400).send('Loja inválida no state.');
    }

    // troca o CODE por tokens
    const tokenData = await exchangeCodeForToken(code);

    if (!tokenData?.access_token) {
      console.error('[ME][CALLBACK] Token inválido recebido:', tokenData);
      return res.status(400).send('Falha ao obter token do Melhor Envio.');
    }

    const expiresAt = calcExpiresAt(tokenData.expires_in);

    // salva os tokens no banco (um registro por loja)
    const { error: upsertErr } = await supabaseDb
      .from('melhorenvio_tokens')
      .upsert(
        {
          loja_id: lojaId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          token_type: tokenData.token_type || 'Bearer',
          created_at: new Date().toISOString(),
          expires_at: expiresAt
        },
        { onConflict: 'loja_id' }
      );

    if (upsertErr) {
      console.error('[ME][CALLBACK] Erro salvando token no Supabase:', upsertErr);
      return res.status(500).send('Erro ao salvar token do Melhor Envio.');
    }

    console.log('[ME][CALLBACK] Token salvo para loja:', lojaId);

    // limpa o state da sessão por segurança
    req.session.me_state = null;

    // Após integrar, redireciona para painel/vendedor
    return res.redirect('/painel/loja?me_integrado=1');
  } catch (err) {
    console.error('[ME][CALLBACK] EXCEPTION', err);
    return res.status(500).send('Erro interno ao finalizar integração com Melhor Envio.');
  }
});

/**
 * GET /integracoes/melhorenvio/debug
 * Rota de teste para verificar se:
 *  - o usuário tem loja
 *  - existe token salvo
 *  - o refresh está funcionando
 *
 * Opcionalmente você pode depois trocar para chamar algum endpoint real da API.
 */
router.get('/integracoes/melhorenvio/debug', async (req, res) => {
  try {
    const usr = req.session?.usuario || {};
    if (!usr.id) {
      return res.status(401).send('Faça login para testar a integração com o Melhor Envio.');
    }

    const { data: loja, error: lojaErr } = await supabaseDb
      .from('lojas')
      .select('id')
      .eq('usuario_id', usr.id)
      .maybeSingle();

    if (lojaErr || !loja) {
      console.error('[ME][DEBUG] Loja não encontrada para usuário:', usr.id, lojaErr);
      return res
        .status(400)
        .send('Você precisa criar sua loja antes de testar a integração com o Melhor Envio.');
    }

    const lojaId = loja.id;
    const accessToken = await getValidAccessToken(lojaId);

    // Aqui você pode futuramente chamar um endpoint real do Melhor Envio.
    // Para evitar chute de endpoint errado, por enquanto só retornamos meta-info.
    return res.json({
      ok: true,
      lojaId,
      hasAccessToken: !!accessToken,
      message:
        'Token do Melhor Envio recuperado (e renovado se necessário). Integração aparentemente OK.'
    });
  } catch (err) {
    console.error('[ME][DEBUG] EXCEPTION', err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
});

module.exports = router;
