let supabaseClient = null;

// Inicializa o cliente Supabase buscando configuração pública do servidor
async function initSupabaseClient() {
  try {
    const res = await fetch('/api/auth/config', { cache: 'no-store' });
    if (!res.ok) return null;
    const cfg = await res.json();

    const key = cfg.supabase_publishable_key || cfg.supabase_anon_key;
    if (cfg.ok && cfg.supabase_url && key && window.supabase) {
      supabaseClient = window.supabase.createClient(cfg.supabase_url, key);
      
      // Verificar se já existe sessão ativa e válida ao carregar a tela
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session?.user && session?.access_token) {
        const { data: { user } } = await supabaseClient.auth.getUser();
        const role = user?.app_metadata?.role;
        if (role === 'admin') {
          window.location.replace('/');
          return;
        } else if (role === 'viewer') {
          window.location.replace('/mapa.html');
          return;
        }
      }
    }
  } catch (err) {
    console.warn('Aviso: Configuração pública do Supabase não carregada:', err);
  }
}

initSupabaseClient();

// 2. Elementos do DOM
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
  hideError();
  setLoading(true);

  try {
    if (!supabaseClient) {
      await initSupabaseClient();
    }

    if (!supabaseClient) {
      showError('Chave pública Supabase pendente de configuração.');
      setLoading(false);
      return;
    }

    // Chamada oficial signInWithPassword
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email.trim(),
      password: password
    });

    if (error || !data?.user || !data?.session) {
      showError('E-mail ou senha inválidos.');
      setLoading(false);
      return;
    }

    // Validação estrita do usuário autenticado
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      showError('Erro ao validar perfil de usuário.');
      setLoading(false);
      return;
    }
    
    // Obtenção da Role oficial em app_metadata (fonte segura)
    const role = user.app_metadata?.role;

    if (role === 'admin') {
      // ADMIN -> Dashboard Principal
      window.location.replace('/');
    } else if (role === 'viewer') {
      // VIEWER -> Mapa Operacional
      window.location.replace('/mapa.html');
    } else {
      // Role não autorizada / inexistente -> desconectar imediatamente
      await supabaseClient.auth.signOut();
      showError('Usuário sem permissão de acesso ao sistema.');
      setLoading(false);
    }

  } catch (err) {
    showError('Erro ao comunicar com o servidor de autenticação.');
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
