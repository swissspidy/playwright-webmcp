import { useState } from "react";
import { useWebMCP } from "use-webmcp-tool";
import { addToCartTool, catalogue, searchTool } from "./tools.js";

export function App() {
  const [cart, setCart] = useState([]);
  const [subscribed, setSubscribed] = useState("");

  // Imperative tools: registered while the component is mounted, unregistered on unmount.
  const search = useWebMCP(searchTool);
  useWebMCP(addToCartTool(cart, setCart));

  // A declarative tool: the form itself, with a name, a description and labelled fields.
  function onSubscribe(event) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    setSubscribed(String(email));
    // When an agent filled the form, answer it through the SubmitEvent.
    event.nativeEvent.respondWith?.({ subscribed: email });
  }

  return (
    <main>
      <h1>Demo shop</h1>
      <p>{search.supported ? (search.registered ? "Agent tools ready" : "Registering tools…") : "WebMCP is not available in this browser"}</p>

      <ul>
        {catalogue.map((p) => (
          <li key={p.id}>
            {p.name}, {p.price}
          </li>
        ))}
      </ul>
      <p id="cart">Cart: {cart.length} item(s)</p>

      <form
        toolname="subscribe_newsletter"
        tooldescription="Subscribe an email address to the weekly newsletter and confirm the subscription."
        onSubmit={onSubscribe}
      >
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" required toolparamdescription="Email address to subscribe" />
        <label>
          Frequency
          <select name="frequency" toolparamdescription="How often to send the newsletter">
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <button type="submit">Subscribe</button>
      </form>
      <p id="newsletter-status">{subscribed ? `Subscribed ${subscribed}` : ""}</p>
    </main>
  );
}
