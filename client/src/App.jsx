import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginView } from './pages/LoginView';
import { RegisterView } from './pages/RegisterView';
import { ImportView } from './pages/ImportView';
import { DashboardView } from './pages/DashboardView';
import { GamesView } from './pages/GamesView';
import { GameView } from './pages/GameView';
import { TrainingPlanView } from './pages/TrainingPlanView';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="login" element={<LoginView />} />
        <Route path="register" element={<RegisterView />} />
        <Route
          path="dashboard"
          element={
            <ProtectedRoute>
              <DashboardView />
            </ProtectedRoute>
          }
        />
        <Route
          path="import"
          element={
            <ProtectedRoute>
              <ImportView />
            </ProtectedRoute>
          }
        />
        <Route
          path="games"
          element={
            <ProtectedRoute>
              <GamesView />
            </ProtectedRoute>
          }
        />
        <Route
          path="games/:id"
          element={
            <ProtectedRoute>
              <GameView />
            </ProtectedRoute>
          }
        />
        <Route
          path="training"
          element={
            <ProtectedRoute>
              <TrainingPlanView />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
