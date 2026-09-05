import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Cliente Supabase server-side para validação de tokens
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Valida se a requisição possui um token JWT de usuário válido com uma das roles permitidas em app_metadata.
 * @param {object} req - Requisição HTTP
 * @param {object} res - Resposta HTTP
 * @param {string[]} allowedRoles - Lista de roles permitidas (ex: ['viewer', 'admin'])
 * @returns {Promise<{ user: object } | null>} Retorna o objeto do usuário se autenticado, ou null se erro enviado.
 */
export async function requireRole(req, res, allowedRoles = ['admin']) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      return null;
    }

    const parts = authHeader.trim().split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      return null;
    }

    const token = parts[1].trim();
    if (!token) {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      return null;
    }

    // Validação real contra o Supabase Auth (servidor oficial, não apenas decodificação)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      return null;
    }

    // Validação estrita de Role em app_metadata (imutável pelo usuário comum)
    const userRole = user.app_metadata?.role;

    if (!allowedRoles.includes(userRole)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      return null;
    }

    return { user };

  } catch (err) {
    // Erro inesperado na checagem - responde 401 genérico sem expor dados internos
    res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    return null;
  }
}

/**
 * Valida se a requisição possui um token JWT de usuário válido com role 'admin' em app_metadata.
 */
export async function requireAdminAuth(req, res) {
  return requireRole(req, res, ['admin']);
}

/**
 * Valida se a requisição possui um token JWT de usuário válido com role 'viewer' ou 'admin' em app_metadata.
 */
export async function requireViewerOrAdmin(req, res) {
  return requireRole(req, res, ['viewer', 'admin']);
}

