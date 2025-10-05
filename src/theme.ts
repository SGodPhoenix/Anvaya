// src/theme.ts
import { MD3DarkTheme as DarkTheme, MD3LightTheme as LightTheme } from 'react-native-paper';
export const theme = {
  ...LightTheme,
  colors: {
    ...LightTheme.colors,
    primary: '#5b67f1',
    secondary: '#00BFA6',
  },
};
