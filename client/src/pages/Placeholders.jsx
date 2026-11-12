import React from 'react';

export function PlaceholderPage({ title }) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 max-w-2xl mx-auto mt-8">
      <h1 className="text-2xl font-bold tracking-tight mb-2 text-gray-900 dark:text-gray-100">{title}</h1>
      <p className="text-gray-600 dark:text-gray-400">coming soon</p>
    </div>
  );
}

export function DashboardPage() {
  return <PlaceholderPage title="Dashboard" />;
}

export function GamesPage() {
  return <PlaceholderPage title="Games" />;
}

export function GameDetailPage() {
  return <PlaceholderPage title="Game Details" />;
}

export function TrainingPage() {
  return <PlaceholderPage title="Training" />;
}

