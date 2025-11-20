// routes/frete.js
const express = require('express');
const supabaseDb = require('../supabase/supabaseDb');
const { carregarCarrinhoSnapshot } = require('../utils/carrinho');
const { melhorEnvioRequest } = require('../services/melhorEnvio'); // serviço de integração

const router = express.Router();

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
        // 1) pega token do Melhor Envio salvo para a LOJA
        const { data: tokenRow, error: tokenErr } = await supabaseDb
          .from('melhorenvio_tokens')
          .select('*')
          .eq('loja_id', primeiraLojaId)
          .maybeSingle();

        if (tokenErr) {
          console.warn('[FRETE][GET] Erro lendo token Melhor Envio:', tokenErr);
        }

        if (tokenRow?.access_token) {
          const accessToken = tokenRow.access_token;

          // 2) CEP de origem (loja) – pega da tabela lojas, senão fallback
          let cepOrigem = '13097173';
          const { data: lojaRow, error: lojaErr } = await supabaseDb
            .from('lojas')
            .select('id, cep')
            .eq('id', primeiraLojaId)
            .maybeSingle();

          if (lojaErr) {
            console.warn('[FRETE][GET] Erro buscando loja para CEP de origem:', lojaErr);
          } else if (lojaRow?.cep) {
            cepOrigem = String(lojaRow.cep).replace(/\D+/g, '');
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

          console.log('[FRETE][GET] Cotações Melhor Envio:', cotacoes?.length || 0);
        } else {
          console.warn('[FRETE][GET] Nenhum access_token do Melhor Envio encontrado para esta loja. Usando opções mock.');
        }
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
