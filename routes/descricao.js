const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Schema que garante dois campos distintos
const responseSchema = {
  type: "object",
  properties: {
    introducao: { type: "string" },       // parágrafo curto de apresentação
    especificacoes: {
      type: "array",
      items: { type: "string" },
      minItems: 1
    }
  },
  required: ["introducao", "especificacoes"]
};

router.post('/gerar-descricao', async (req, res) => {
  try {
    const { nome, shape, marca, tipo, categoria, caracteristicas = "" } = req.body || {};

    if (!nome || !marca || !tipo || !categoria) {
      return res.status(400).json({ error: 'Campos obrigatórios: nome, marca, tipo, categoria.' });
    }

    const caracteristicasClean = String(caracteristicas || '').slice(0, 2000);

const systemInstruction = `
Você é um assistente especializado em criar descrições técnicas de instrumentos musicais para marketplaces.

Sua tarefa é gerar um texto dividido em duas partes, com linguagem neutra, objetiva e informativa. 
Evite tom promocional, expressões de venda ou adjetivos subjetivos como "incrível", "icônico", "renomado", "excelente", etc.

Parte 1: "introducao" (parágrafo único, 60–100 palavras)
- Descreva o instrumento de forma natural, apresentando **marca**, **modelo** e **shape** (se houver).
- Use "tipo" e "categoria" apenas se fizerem sentido gramatical (ex: “instrumento de cordas” ou “amplificador para guitarra”), nunca em repetições como “guitarra do tipo corda”.
- Foque em características construtivas e funcionais: materiais do corpo e braço, escala, número de trastes, tipo de captadores, ponte, tarraxas, controles, etc.
- Não use verbos no imperativo nem termos que indiquem avaliação de qualidade.
- O objetivo é que soe como uma ficha técnica escrita em texto corrido, sem exageros ou repetições.

Parte 2: "especificacoes" (lista)
- Extraia fielmente TODAS as especificações técnicas do texto fornecido pelo vendedor.
- Mantenha medidas, materiais e nomes originais.
- Liste cada item no formato "Chave: valor".
- Não inclua comentários adicionais nem crie informações novas.

Importante:
- Nunca invente detalhes que não estejam mencionados.
- Se o texto não se referir a um item musical, responda com:
  "Não foi possível gerar a descrição a partir deste texto."
- Traduza para português do Brasil, se necessário.
`.trim();


    // ⚠️ mantenha os dados sem observações entre parênteses
    const userPrompt = `
Gere APENAS JSON válido conforme o schema, com os campos "introducao" e "especificacoes".
Se necessário, inclua também "erro" (string) apenas no caso não musical.

Dados do produto:
- Nome: ${nome}
- Marca: ${marca}
- Tipo: ${tipo}
- Categoria: ${categoria}
- Shape/Modelo: ${shape || 'n/d'}

Texto do vendedor:
"""
${caracteristicasClean || 'n/d'}
"""
`.trim();

    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            introducao: { type: "string" },
            especificacoes: {
              type: "array",
              items: { type: "string" }
            },
            erro: { type: "string" }
          },
          required: ["introducao", "especificacoes"]
        }
      },
      systemInstruction
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }]
    });

    // 🔧 Sanitiza cercas de código antes do parse
    const raw = (result.response?.text?.() || "").trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '');

    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      console.error("Falha ao parsear JSON:", raw);
      return res.status(500).json({ error: 'Falha ao gerar descrição no formato esperado.' });
    }

    if (parsed.erro) {
      return res.status(400).json({ error: parsed.erro });
    }

    if (!parsed?.introducao || !Array.isArray(parsed?.especificacoes)) {
      return res.status(500).json({ error: 'Falha ao gerar descrição no formato esperado.' });
    }

    const descricaoFinal = `${parsed.introducao}\n\nEspecificações:\n${parsed.especificacoes.map(s => `- ${s}`).join('\n')}`;

    return res.json({
      descricao: descricaoFinal,
      introducao: parsed.introducao,
      especificacoes: parsed.especificacoes
    });

  } catch (err) {
    console.error('Erro /gerar-descricao:', err);
    return res.status(500).json({ error: 'Erro ao gerar descrição.' });
  }
});

module.exports = router;
