export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || null;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;

    if (!supabaseUrl || !publishableKey) {
      return res.status(200).json({
        ok: false,
        error: 'Chave pública Supabase não configurada no ambiente.',
        supabase_url: supabaseUrl,
        supabase_publishable_key: null
      });
    }

    return res.status(200).json({
      ok: true,
      supabase_url: supabaseUrl,
      supabase_publishable_key: publishableKey
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Erro ao carregar configuração pública.' });
  }
}
