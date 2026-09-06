let supabaseClient = null;
let isSubmitting = false;

// 1. Detectar forceReauth antes de qualquer verificação de sessão
const forceReauth = new URLSearchParams(window.location.search).get('expired') === '1';

// 2. Elementos do DOM (declarados antes para uso em initSupabaseClient se necessário)
const loginForm = document.getElementById('login-form');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const btnLogin = document.getElementById('btn-login');
const btnText = document.getElementById('btn-text');
const btnSpinner = document.getElementById('btn-spinner');
const errorBanner = document.getElementById('login-error-msg');
const errorText = document.getElementById('error-text');
const btnTogglePw = document.getElementById('btn-toggle-password');
const iconEye = document.getElementById('icon-eye');
const iconEyeOff = document.getElementById('icon-eye-off');

// 3. Utilitários de Interface
function showError(message) {
  if (!errorBanner || !errorText) return;
  errorText.textContent = message || 'E-mail ou senha inválidos.';
  errorBanner.classList.remove('hidden');
}

function hideError() {
  if (!errorBanner) return;
  errorBanner.classList.add('hidden');
}

function setLoading(isLoading) {
  if (!btnLogin || !btnText || !btnSpinner) return;
  if (isLoading) {
    btnLogin.disabled = true;
    btnText.textContent = 'Entrando...';
    btnSpinner.classList.remove('hidden');
  } else {
    btnLogin.disabled = false;
    btnText.textContent = 'ENTRAR';
    btnSpinner.classList.add('hidden');
  }
}

// Utilitário para confirmar persistência de sessão antes de navegar
async function confirmPersistedSession(maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (!supabaseClient) return null;
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (!error && session?.access_token) return session;
    } catch (e) {}
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 100 * (i + 1)));
    }
  }
  return null;
}

// Carregar configuração do servidor com retries curtos
async function loadAuthConfigWithRetry(maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch('/api/auth/config', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        const key = cfg.supabase_publishable_key || cfg.supabase_anon_key;
        if (cfg.ok && cfg.supabase_url && key && window.supabase) {
          return { cfg, key };
        }
      }
    } catch (e) {}
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 150 * Math.pow(2, i)));
    }
  }
  return null;
}

// Inicializa o cliente Supabase buscando configuração pública do servidor
async function initSupabaseClient() {
  try {
    const authConfig = await loadAuthConfigWithRetry(3);
    if (!authConfig) return null;
    const { cfg, key } = authConfig;

    supabaseClient = window.supabase.createClient(cfg.supabase_url, key);
    
    // Se veio com ?expired=1, limpar sessão residual localmente e bloquear auto-login
    if (forceReauth) {
      try {
        await supabaseClient.auth.signOut({ scope: 'local' });
      } catch (e) {
        try { await supabaseClient.auth.signOut(); } catch (err) {}
      }
      showError('Sua sessão expirou. Entre novamente.');
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      return;
    }

    // Se NÃO for forceReauth, verificar se já existe sessão ativa e válida ao carregar a tela
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.user && session?.access_token) {
      const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
      if (!userError && user) {
        const role = user.app_metadata?.role;
        if (role === 'admin') {
          window.location.replace('/');
          return;
        } else if (role === 'viewer') {
          window.location.replace('/mapa.html');
          return;
        }
      } else if (userError) {
        // Se a sessão existente for comprovadamente inválida, limpa para evitar estado zumbi
        try { await supabaseClient.auth.signOut({ scope: 'local' }); } catch (e) {}
      }
    }
  } catch (err) {
    console.warn('Aviso: Configuração pública do Supabase não carregada:', err);
  }
}

initSupabaseClient();

// 4. Toggle de Visibilidade da Senha
if (btnTogglePw && inputPassword) {
  btnTogglePw.addEventListener('click', () => {
    const isPassword = inputPassword.type === 'password';
    inputPassword.type = isPassword ? 'text' : 'password';
    if (iconEye && iconEyeOff) {
      if (isPassword) {
        iconEye.classList.add('hidden');
        iconEyeOff.classList.remove('hidden');
      } else {
        iconEye.classList.remove('hidden');
        iconEyeOff.classList.add('hidden');
      }
    }
  });
}

// 5. Processamento de Login
async function handleLogin(email, password) {
  if (isSubmitting) return;
  isSubmitting = true;
  hideError();
  setLoading(true);

  try {
    if (!supabaseClient) {
      await initSupabaseClient();
    }

    if (!supabaseClient) {
      showError('Chave pública Supabase pendente de configuração.');
      isSubmitting = false;
      setLoading(false);
      return;
    }

    // Chamada oficial signInWithPassword
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email.trim(),
      password: password
    });

    if (error || !data?.user || !data?.session?.access_token) {
      showError('E-mail ou senha inválidos.');
      isSubmitting = false;
      setLoading(false);
      return;
    }

    // Confirmar que a sessão está gravada no storage antes de redirecionar
    const confirmedSession = await confirmPersistedSession(3);
    if (!confirmedSession) {
      try { await supabaseClient.auth.signOut({ scope: 'local' }); } catch (e) {}
      showError('Não foi possível concluir a sessão. Tente entrar novamente.');
      isSubmitting = false;
      setLoading(false);
      return;
    }

    // Obtenção da Role oficial em app_metadata (fonte segura)
    let role = data.user.app_metadata?.role;
    if (!role) {
      const { data: userData } = await supabaseClient.auth.getUser().catch(() => ({ data: {} }));
      role = userData?.user?.app_metadata?.role;
    }

    if (role === 'admin') {
      window.location.replace('/');
    } else if (role === 'viewer') {
      window.location.replace('/mapa.html');
    } else {
      try {
        await supabaseClient.auth.signOut({ scope: 'local' });
      } catch (e) {
        try { await supabaseClient.auth.signOut(); } catch (err) {}
      }
      showError('Usuário sem permissão de acesso ao sistema.');
      isSubmitting = false;
      setLoading(false);
    }

  } catch (err) {
    showError('Erro ao comunicar com o servidor de autenticação.');
    isSubmitting = false;
    setLoading(false);
  }
}

// 6. Event Listener do Formulário
if (loginForm && inputEmail && inputPassword) {
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = inputEmail.value;
    const password = inputPassword.value;

    if (!email || !password) {
      showError('Preencha o e-mail e a senha.');
      return;
    }

    handleLogin(email, password);
  });
}
