import { render } from '@testing-library/react'
import { screen } from '@testing-library/dom';
import Home from '@/app/(public)/page';

describe('Home', () => {
  it('renders a heading', () => {
    render(<Home />);
    const heading = screen.getByText(/Welcome to AI Studio/i);
    expect(heading).toBeInTheDocument();
  });
});
