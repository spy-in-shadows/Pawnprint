const API_PREFIX = '/api/v1';

export function getStoredToken() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

export function clearStoredToken() {
  try {
    localStorage.removeItem('token');
  } catch {
    // Ignore storage errors
  }
}

export async function apiRequest(path, options = {}) {
  const url = path.startsWith('/api') ? path : `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  const token = getStoredToken();

  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;

  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearStoredToken();
    if (typeof window !== 'undefined' && window.location && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }

  let data;
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const errorInfo = data && typeof data === 'object' && data.error ? data.error : null;
    const message = (errorInfo && errorInfo.message) || (typeof data === 'string' && data) || response.statusText || 'Request failed';
    const error = new Error(message);
    if (errorInfo && errorInfo.code) {
      error.code = errorInfo.code;
    }
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export const api = {
  get: (path, options) => apiRequest(path, { ...options, method: 'GET' }),
  post: (path, body, options) => {
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    return apiRequest(path, {
      ...options,
      method: 'POST',
      body: isFormData ? body : JSON.stringify(body),
    });
  },
  put: (path, body, options) => apiRequest(path, { ...options, method: 'PUT', body: JSON.stringify(body) }),
  patch: (path, body, options) => apiRequest(path, { ...options, method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path, options) => apiRequest(path, { ...options, method: 'DELETE' }),
};

export default api;
