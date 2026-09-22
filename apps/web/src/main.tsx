import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './components/AuthProvider';
import { SPA_BASE_PATH } from './lib/api';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

// react-router's basename is Vite's BASE_URL without the trailing slash:
// `/` (single-app default) becomes ``, which react-router treats as no
// basename; `/tax/` (multi-app overlay) becomes `/tax`, so route paths like
// `/setup` continue to match against the substring after the prefix.
const routerBasename = SPA_BASE_PATH;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={routerBasename}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
