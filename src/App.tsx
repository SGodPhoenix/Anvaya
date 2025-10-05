// src/App.tsx
import React from 'react';
import { StatusBar } from 'react-native';
import { Provider as PaperProvider } from 'react-native-paper';
import { NavigationContainer } from '@react-navigation/native';

import RootNavigator from './navigation/RootNavigator';
import { theme } from './theme';

/**
 * NOTE: Make sure NavigationContainer is NOT used inside RootNavigator.
 * This should be the ONLY NavigationContainer in the app to avoid the
 * "nested NavigationContainer" render error.
 */
export default function App() {
  return (
    <PaperProvider theme={theme}>
      <StatusBar barStyle="dark-content" />
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>
    </PaperProvider>
  );
}
