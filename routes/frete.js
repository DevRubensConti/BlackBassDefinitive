// routes/frete.js
const express = require('express');
const supabaseDb = require('../supabase/supabaseDb');
const { carregarCarrinhoSnapshot } = require('../utils/carrinho');
const { melhorEnvioRequest, refreshAccessToken } = require('../services/melhorEnvio'); // serviço de integração

const router = express.Router();

// ===============================
// Helper: token do Melhor Envio por loja (com refresh)
// ===============================
async function getValidAccessTokenForLoja(lojaId) {
  const { data: row, error } = await supabaseDb
    .from('melhorenvio_tokens')
    .select('access_token, refresh_token, expires_in, token_type, created_at, expires_at')
    .eq('loja_id', lojaId)
    .maybeSingle();

  if (error) {
    console.error('[FRETE][ME][TOKEN] Erro ao buscar token no Supabase:', error);
    throw new Error('Erro ao buscar token do Melhor Envio.');
  }

  if (!row || !row.access_token) {
    throw new Error('Nenhum token do Melhor Envio encontrado para esta loja.');
  }

  const now = Date.now();

  let expiresAtMs;
  if (row.expires_at) {
    // Novo formato (recomendado): coluna expires_at
    expiresAtMs = new Date(row.expires_at).getTime();
  } else {
    // Formato legado: usa created_at + expires_in
    const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : now;
    const expiresInMs = (row.expires_in || 3600) * 1000;
    expiresAtMs = createdAtMs + expiresInMs;
  }

  // Renova se faltam menos de 5 minutos para expirar
  const willExpireSoon = !expiresAtMs || now > expiresAtMs - 5 * 60 * 1000;

  if (!willExpireSoon || !row.refresh_token) {
    return row.access_token;
  }

  console.log('[FRETE][ME][TOKEN] Token próximo de expirar. Renovando via refresh_token…');

  const newTokens = await refreshAccessToken(row.refresh_token);

  const expiresAt = new Date(
    Date.now() + (newTokens.expires_in || row.expires_in || 3600) * 1000
  ).toISOString();

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
    console.error('[FRETE][ME][TOKEN] Erro ao salvar token renovado no Supabase:', upsertErr);
    throw new Error('Erro ao salvar token renovado do Melhor Envio.');
  }

  console.log('[FRETE][ME][TOKEN] Token renovado com sucesso para loja:', lojaId);
  return newTokens.access_token;
}

// GET /checkout/frete – mostra a página do gateway de frete
router.get('/checkout/frete', async (req, res) => {
  try {
    const usr = req.session?.usuario || {};
    const compradorId = usr?.id;
    const tipoUsuario = (usr?.tipo || '').toLowerCase(); // 'pf' | 'pj'

    if (!compradorId || !tipoUsuario) {
      return res.redirect('/login');
    }

    // reaproveita a mesma lógica do carrinho (já trazendo produtos.*)
    const itensCarrinho = await carregarCarrinhoSnapshot(compradorId, tipoUsuario);

    if (!itensCarrinho || !itensCarrinho.length) {
      return res.render('frete_gateway', {
        usuario: usr,
        itensCarrinho: [],
        subtotal: 0,
        freteSelecionado: null,
        cotacoes: []
      });
    }

    const subtotal = itensCarrinho.reduce((acc, row) => {
      const prod = row.produtos || {};
      const preco = Number(prod.preco || 0);
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      return acc + preco * qtd;
    }, 0);

    // frete que o usuário eventualmente já escolheu antes
    const freteSelecionado = req.session.freteSelecionado || null;

    // ===============================
    // Integração com Melhor Envio
    // ===============================
    let cotacoes = [];

    try {
      // 0) Descobrir de qual loja é o carrinho (MVP: assume 1 loja)
      const primeiraLojaId = itensCarrinho[0]?.produtos?.loja_id || null;

      if (!primeiraLojaId) {
        console.warn('[FRETE][GET] Carrinho sem loja_id nos produtos. Pulando Melhor Envio.');
      } else {
        // 1) pega token do Melhor Envio salvo para a LOJA (com refresh automático)
        const accessToken = await getValidAccessTokenForLoja(primeiraLojaId);

        // 2) CEP de origem (loja)
        // Busca o CEP do dono da loja (PF ou PJ) via usuario_id + doc_tipo.
        let cepOrigem = process.env.MELHOR_ENVIO_CEP_ORIGEM || '13097173';

        const { data: lojaRow, error: lojaErr } = await supabaseDb
          .from('lojas')
          .select('id, usuario_id, doc_tipo')
          .eq('id', primeiraLojaId)
          .maybeSingle();

        if (lojaErr) {
          console.warn('[FRETE][GET] Erro buscando loja para CEP de origem:', lojaErr);
        } else if (lojaRow?.usuario_id) {
          const docTipo = (lojaRow.doc_tipo || '').toUpperCase();

          try {
            if (docTipo === 'CNPJ') {
              // Loja PJ → buscar em usuarios_pj
              const { data: pj, error: pjErr } = await supabaseDb
                .from('usuarios_pj')
                .select('cep')
                .eq('id', lojaRow.usuario_id)
                .maybeSingle();

              if (pjErr) {
                console.warn(
                  '[FRETE][GET] Erro buscando usuarios_pj para CEP origem:',
                  pjErr
                );
              } else if (pj?.cep) {
                cepOrigem = String(pj.cep).replace(/\D+/g, '');
              }
            } else {
              // Loja PF → buscar em usuarios_pf
              const { data: pf, error: pfErr } = await supabaseDb
                .from('usuarios_pf')
                .select('cep')
                .eq('id', lojaRow.usuario_id)
                .maybeSingle();

              if (pfErr) {
                console.warn(
                  '[FRETE][GET] Erro buscando usuarios_pf para CEP origem:',
                  pfErr
                );
              } else if (pf?.cep) {
                cepOrigem = String(pf.cep).replace(/\D+/g, '');
              }
            }
          } catch (cepErr) {
            console.warn(
              '[FRETE][GET] Erro geral ao resolver CEP origem da loja:',
              cepErr
            );
          }
        }

        // 3) CEP de destino (comprador) – usa usuarios_pf / usuarios_pj
        let cepDestino = '13097173';

        if (tipoUsuario === 'pf') {
          const { data: pf, error: pfErr } = await supabaseDb
            .from('usuarios_pf')
            .select('cep')
            .eq('id', compradorId)
            .maybeSingle();

          if (pfErr) {
            console.warn('[FRETE][GET] Erro buscando usuarios_pf para CEP destino:', pfErr);
          } else if (pf?.cep) {
            cepDestino = String(pf.cep).replace(/\D+/g, '');
          }
        } else {
          const { data: pj, error: pjErr } = await supabaseDb
            .from('usuarios_pj')
            .select('cep')
            .eq('id', compradorId)
            .maybeSingle();

          if (pjErr) {
            console.warn('[FRETE][GET] Erro buscando usuarios_pj para CEP destino:', pjErr);
          } else if (pj?.cep) {
            cepDestino = String(pj.cep).replace(/\D+/g, '');
          }
        }

        // 4) monta payload de cotação (exemplo; depois refine com peso/medidas reais)
        const payload = {
          from: {
            postal_code: cepOrigem
          },
          to: {
            postal_code: cepDestino
          },
          products: itensCarrinho.map((row) => {
            const prod = row.produtos || {};
            const qtd = Number(row.quantidade || 1);

            return {
              id: prod.id,
              width: 11,
              height: 2,
              length: 16,
              weight: 0.3,
              quantity: qtd,
              insurance_value: Number(prod.preco || 0) * qtd
            };
          })
        };

        // 5) chama a API de cálculo do Melhor Envio
        cotacoes = await melhorEnvioRequest(
          '/api/v2/me/shipment/calculate',
          accessToken,
          {
            method: 'POST',
            body: JSON.stringify(payload)
          }
        );

        console.log(
          '[FRETE][GET] Cotações Melhor Envio:',
          Array.isArray(cotacoes) ? cotacoes.length : 0
        );
      }
    } catch (errME) {
      console.error('[FRETE][GET] Erro na cotação Melhor Envio:', errME);
      // se der erro, só segue com cotacoes = [] e as opções mock do EJS
    }

    return res.render('frete_gateway', {
      usuario: usr,
      itensCarrinho,
      subtotal,
      freteSelecionado,
      cotacoes // view já recebe cotações reais quando existirem
    });
  } catch (err) {
    console.error('[FRETE][GET] ERRO', err);
    return res.status(500).send('Erro ao carregar página de frete.');
  }
});

// POST /checkout/frete – recebe opção de frete e segue para pagamento (Bricks)
router.post('/checkout/frete', (req, res) => {
  try {
    const { metodo, valor, prazo } = req.body;

    // guarda na sessão pra usar depois no /api/checkout/bricks
    req.session.freteSelecionado = {
      metodo: metodo || 'desconhecido',
      valor: Number(valor || 0),
      prazo: prazo || ''
    };

    // segue para a página de pagamento com Bricks
    return res.redirect('/api/checkout/bricks');
  } catch (err) {
    console.error('[FRETE][POST] ERRO', err);
    return res.status(500).send('Erro ao salvar frete.');
  }
});

module.exports = router;
